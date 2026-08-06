#!/usr/bin/env bash
#
# Smoke test a built renderready image.
#
# Checks that the container actually renders, not merely that it starts — and
# specifically that browser recycling does not leak zombie Chromium processes,
# which is the failure mode the init process in the Dockerfile exists to prevent.
# Without it, six defunct `headless_shell` processes accumulate over three
# recycles, so this check is load-bearing rather than decorative.
#
# Usage: scripts/docker-smoke.sh [image] [port]
set -uo pipefail

IMAGE="${1:-renderready:local}"
PORT="${2:-3123}"
NAME="renderready-smoke-$$"
TARGET="https://example.com/"
fails=0

pass() { printf '  PASS  %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n' "$1"
  fails=$((fails + 1))
}

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

render() { curl -fsS "http://localhost:${PORT}/render?url=$(printf %s "$TARGET" | sed 's|:|%3A|g; s|/|%2F|g')"; }
status_of() { curl -s -o /dev/null -w '%{http_code}' "$1"; }

echo "== starting $IMAGE =="
# A low recycle threshold so a handful of renders forces several browser
# relaunches, which is what orphans Chromium's child processes.
docker run -d --name "$NAME" -p "${PORT}:3000" --shm-size=1g \
  -e RECYCLE_AFTER_RENDERS=2 -e LOG_LEVEL=info "$IMAGE" >/dev/null || {
  echo "could not start the container"
  exit 1
}

echo "== waiting for /health =="
ready=0
for _ in $(seq 1 45); do
  if curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" != 1 ]; then
  fail "health endpoint never responded"
  docker logs "$NAME" 2>&1 | tail -30
  exit 1
fi
pass "health endpoint responds"

echo "== container identity =="
docker exec "$NAME" id -un 2>/dev/null | grep -q '^pwuser$' &&
  pass "runs as non-root (pwuser)" || fail "not running as pwuser"

pid1=$(docker exec "$NAME" cat /proc/1/comm 2>/dev/null)
case "$pid1" in
*tini* | *init*) pass "PID 1 is an init process ($pid1)" ;;
*) fail "PID 1 is '$pid1'; orphaned Chromium children will not be reaped" ;;
esac

curl -fsS "http://localhost:${PORT}/health" | grep -q '"status":"ok"' &&
  pass "health reports ok" || fail "unexpected health payload"

echo "== rendering =="
body=$(render)
grep -q 'Example Domain' <<<"$body" &&
  pass "rendered the expected content" || fail "expected content missing"
grep -qi '<script' <<<"$body" &&
  fail "scripts were not stripped" || pass "scripts stripped"
grep -qi '<!doctype html>' <<<"$body" &&
  pass "doctype preserved" || fail "doctype missing"

echo "== error and redirect handling =="
code=$(status_of "http://localhost:${PORT}/render?url=not-a-url")
[ "$code" = 400 ] && pass "malformed url -> 400" || fail "malformed url -> $code"

code=$(status_of "http://localhost:${PORT}/render?url=file:///etc/passwd")
[ "$code" = 400 ] && pass "file:// scheme -> 400" || fail "file:// scheme -> $code"

code=$(status_of "http://localhost:${PORT}/render?url=http%3A%2F%2Fgithub.com%2F")
[ "$code" = 301 ] &&
  pass "redirect reported as 301, not followed" || fail "redirect -> $code (expected 301)"

echo "== browser recycling =="
for i in 1 2 3 4 5 6; do
  code=$(status_of "http://localhost:${PORT}/render?url=https%3A%2F%2Fexample.com%2F")
  [ "$code" = 200 ] || fail "render $i during recycling returned $code"
done
recycles=$(docker logs "$NAME" 2>&1 | grep -c 'Recycling browser')
[ "${recycles:-0}" -ge 2 ] &&
  pass "$recycles recycles happened, all renders still 200" ||
  fail "expected several recycles, saw ${recycles:-0}"

# The check this whole script exists for.
#
# Polled rather than sampled once: reaping is asynchronous, so a child that has
# just exited legitimately shows as Z for a few milliseconds. What matters is
# whether they *drain*. With no init process they accumulate instead — two per
# recycle, never collected — so a count that refuses to reach zero is the signal.
count_zombies() {
  local n
  n=$(docker exec "$NAME" sh -c "ps -eo stat= 2>/dev/null | grep -c '^Z'" 2>/dev/null || echo 0)
  printf '%s' "${n//[^0-9]/}"
}
zombies=$(count_zombies)
for _ in $(seq 1 20); do
  [ "${zombies:-0}" -eq 0 ] && break
  sleep 0.5
  zombies=$(count_zombies)
done
[ "${zombies:-0}" -eq 0 ] &&
  pass "defunct processes drained after $recycles recycles" ||
  fail "$zombies defunct processes persisted; nothing is reaping orphaned children"

echo "== concurrency =="
codes=$(mktemp)
for _ in $(seq 1 8); do
  # Both the code and its newline must be written by the background job itself,
  # or the parent's newlines interleave and every code runs together.
  { printf '%s\n' "$(status_of "http://localhost:${PORT}/render?url=https%3A%2F%2Fexample.com%2F")" >>"$codes"; } &
done
wait
ok=$(grep -c '^200$' "$codes" || true)
rm -f "$codes"
[ "${ok:-0}" = 8 ] &&
  pass "8 concurrent renders all returned 200" || fail "only ${ok:-0}/8 concurrent renders succeeded"

echo "== graceful shutdown =="
docker stop -t 20 "$NAME" >/dev/null 2>&1
exitcode=$(docker inspect -f '{{.State.ExitCode}}' "$NAME" 2>/dev/null)
[ "$exitcode" = 0 ] && pass "exited 0 on SIGTERM" || fail "exit code $exitcode on SIGTERM"
docker logs "$NAME" 2>&1 | grep -q 'Shutting down' &&
  pass "ran the shutdown path" || fail "no shutdown log line"

echo
if [ "$fails" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
else
  echo "$fails CHECK(S) FAILED"
  docker logs "$NAME" 2>&1 | tail -40
fi
exit "$fails"
