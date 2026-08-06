# Publishing

Releases are driven by [changesets](https://github.com/changesets/changesets) and published to npm
with **Trusted Publishing**, so there is no long-lived npm token in this repository.

## Day-to-day

1. Make your change.
2. Run `npx changeset` and describe it. Pick `patch`, `minor` or `major`.
3. Commit the generated file in `.changeset/` alongside your change.

When that lands on `main`, the Release workflow opens (or updates) a `chore: release` pull request
that bumps the version and writes `CHANGELOG.md`. Merging that PR publishes to npm.

## One-time setup

Trusted Publishing has to be enabled on the npm side; the workflow cannot do it for you.

1. Publish `1.0.0` manually once, so the package exists — a trusted publisher is configured
   per-package, so there is nothing to attach it to until then:

   ```bash
   npm login
   npm run build
   npm publish
   ```

   `publishConfig.access` in `package.json` already marks it public, so no flag is needed. Do not add
   `--provenance` here: provenance needs the OIDC token that only CI has, and the command will fail.
   Every later release gets provenance automatically from the workflow.

2. On <https://www.npmjs.com/package/renderready/access>, under **Trusted Publisher**, add a GitHub
   Actions publisher:
   - Organization or user: `lukapozega`
   - Repository: `renderready`
   - Workflow filename: `release.yml`

3. Remove any `NPM_TOKEN` secret from the repository. It is no longer needed, and a leaked token is
   the thing this setup exists to avoid.

Every later release goes through the workflow. Publishing this way also attaches a provenance
attestation, so consumers can verify the tarball was built from this repository.

## Requirements the workflow depends on

- `id-token: write` permission, which is what mints the OIDC token.
- npm 11.5.1 or newer, which is why the workflow upgrades npm before publishing.
- The package must be public (`.changeset/config.json` sets `"access": "public"`).

## Why `esbuild` is pinned

`package.json` forces `esbuild` to `^0.28.1` through `overrides`. This looks like an unexplained pin
and is not: tsup depends on `^0.27.0`, and the 0.27 line carries
[GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr), so removing the override
brings the advisory straight back into `npm audit`. It is build-time only and never reaches
consumers. JSON cannot hold a comment, which is why the reason is recorded here.
