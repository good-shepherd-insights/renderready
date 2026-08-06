import type { Page, Request } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import { trackRequests, waitForPageReady } from '../../src/browser/readiness.js';
import { noopLogger } from '../../src/logger.js';

type Listener = (request: Request) => void;

/** A page that only implements the events and evaluate call readiness uses. */
class FakePage {
  private listeners = new Map<string, Set<Listener>>();
  evaluateResults: unknown[] = [];
  evaluateCalls = 0;

  url = vi.fn(() => 'https://example.test/');

  evaluate = vi.fn(async () => {
    const index = Math.min(this.evaluateCalls, this.evaluateResults.length - 1);
    this.evaluateCalls++;
    const result = this.evaluateResults[index];
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });

  on = vi.fn((event: string, listener: Listener) => {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
  });

  off = vi.fn((event: string, listener: Listener) => {
    this.listeners.get(event)?.delete(listener);
  });

  emit(event: string, resourceType = 'xhr'): void {
    const request = { resourceType: () => resourceType, url: () => 'https://example.test/x' };
    for (const listener of this.listeners.get(event) ?? []) {
      listener(request as unknown as Request);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

const asPage = (page: FakePage): Page => page as unknown as Page;

const READINESS = {
  pageDoneCheckInterval: 10,
  waitAfterLastRequest: 20,
  prerenderReadyDelay: 50,
};

const ready = (prerenderReady: boolean | null) => ({ domReady: true, prerenderReady });

describe('trackRequests', () => {
  it('counts requests up and back down', () => {
    const page = new FakePage();
    const tracker = trackRequests(asPage(page));

    page.emit('request');
    page.emit('request');
    expect(tracker.inFlight()).toBe(2);

    page.emit('requestfinished');
    expect(tracker.inFlight()).toBe(1);

    page.emit('requestfailed');
    expect(tracker.inFlight()).toBe(0);
  });

  it('records activity on every event', async () => {
    const page = new FakePage();
    const tracker = trackRequests(asPage(page));
    const before = tracker.lastActivityAt();

    await new Promise(resolve => setTimeout(resolve, 5));
    page.emit('request');

    expect(tracker.lastActivityAt()).toBeGreaterThan(before);
  });

  // A socket that stays open for the life of the page would otherwise keep the
  // network permanently busy and pin every render at the full timeout.
  it.each(['websocket', 'eventsource'])('ignores long-lived %s requests', resourceType => {
    const page = new FakePage();
    const tracker = trackRequests(asPage(page));

    page.emit('request', resourceType);

    expect(tracker.inFlight()).toBe(0);
  });

  it('detaches its listeners on stop', () => {
    const page = new FakePage();
    const tracker = trackRequests(asPage(page));
    expect(page.listenerCount('request')).toBe(1);

    tracker.stop();

    expect(page.listenerCount('request')).toBe(0);
    expect(page.listenerCount('requestfinished')).toBe(0);
    expect(page.listenerCount('requestfailed')).toBe(0);
  });
});

describe('waitForPageReady', () => {
  const idleTracker = (inFlight = 0, lastActivityAt = Date.now() - 10_000) => ({
    inFlight: () => inFlight,
    lastActivityAt: () => lastActivityAt,
    stop: () => {},
  });

  it('returns as soon as the network is quiet when the page sets no flag', async () => {
    const page = new FakePage();
    page.evaluateResults = [ready(null)];

    const result = await waitForPageReady(
      asPage(page),
      idleTracker(),
      READINESS,
      Date.now() + 1_000,
      noopLogger,
    );

    expect(result).toEqual({ timedOut: false, usedPrerenderReady: false });
  });

  it('waits until the document has parsed', async () => {
    const page = new FakePage();
    page.evaluateResults = [
      { domReady: false, prerenderReady: null },
      { domReady: false, prerenderReady: null },
      ready(null),
    ];

    const result = await waitForPageReady(
      asPage(page),
      idleTracker(),
      READINESS,
      Date.now() + 1_000,
      noopLogger,
    );

    expect(result.timedOut).toBe(false);
    expect(page.evaluateCalls).toBe(3);
  });

  it('keeps polling while requests are in flight, then finishes', async () => {
    const page = new FakePage();
    page.evaluateResults = [ready(null)];
    let inFlight = 2;
    const tracker = {
      inFlight: () => inFlight,
      lastActivityAt: () => Date.now() - 10_000,
      stop: () => {},
    };
    setTimeout(() => {
      inFlight = 0;
    }, 30);

    const result = await waitForPageReady(
      asPage(page),
      tracker,
      READINESS,
      Date.now() + 1_000,
      noopLogger,
    );

    expect(result.timedOut).toBe(false);
  });

  it('does not finish until the quiet window has fully elapsed', async () => {
    const page = new FakePage();
    page.evaluateResults = [ready(null)];
    // Activity happened just now, so the 20ms quiet window is not yet satisfied.
    const tracker = idleTracker(0, Date.now());
    const started = Date.now();

    await waitForPageReady(asPage(page), tracker, READINESS, Date.now() + 1_000, noopLogger);

    expect(Date.now() - started).toBeGreaterThanOrEqual(READINESS.waitAfterLastRequest - 5);
  });

  // The flag is authoritative once declared: false means "not yet", however
  // quiet the network is.
  it('ignores network quiet while prerenderReady is false', async () => {
    const page = new FakePage();
    page.evaluateResults = [ready(false)];

    const result = await waitForPageReady(
      asPage(page),
      idleTracker(),
      READINESS,
      Date.now() + 60,
      noopLogger,
    );

    expect(result).toEqual({ timedOut: true, usedPrerenderReady: true });
  });

  it('captures once prerenderReady turns true', async () => {
    const page = new FakePage();
    page.evaluateResults = [ready(false), ready(false), ready(true)];

    const result = await waitForPageReady(
      asPage(page),
      idleTracker(),
      READINESS,
      Date.now() + 1_000,
      noopLogger,
    );

    expect(result).toEqual({ timedOut: false, usedPrerenderReady: true });
  });

  // An app that declares itself done should not have to wait out its own
  // trailing analytics requests.
  it('captures a ready page with busy network after prerenderReadyDelay', async () => {
    const page = new FakePage();
    page.evaluateResults = [ready(true)];
    const tracker = idleTracker(3, Date.now());
    const started = Date.now();

    const result = await waitForPageReady(
      asPage(page),
      tracker,
      { ...READINESS, prerenderReadyDelay: 40 },
      Date.now() + 2_000,
      noopLogger,
    );

    expect(result).toEqual({ timedOut: false, usedPrerenderReady: true });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(35);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('captures immediately when ready and already quiet', async () => {
    const page = new FakePage();
    page.evaluateResults = [ready(true)];
    const started = Date.now();

    const result = await waitForPageReady(
      asPage(page),
      idleTracker(),
      { ...READINESS, prerenderReadyDelay: 5_000 },
      Date.now() + 2_000,
      noopLogger,
    );

    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('reports a timeout rather than throwing when the budget runs out', async () => {
    const page = new FakePage();
    page.evaluateResults = [{ domReady: false, prerenderReady: null }];

    const result = await waitForPageReady(
      asPage(page),
      idleTracker(),
      READINESS,
      Date.now() + 40,
      noopLogger,
    );

    expect(result.timedOut).toBe(true);
  });

  it('returns immediately when the deadline has already passed', async () => {
    const page = new FakePage();
    page.evaluateResults = [ready(null)];

    const result = await waitForPageReady(
      asPage(page),
      idleTracker(),
      READINESS,
      Date.now() - 1,
      noopLogger,
    );

    expect(result.timedOut).toBe(true);
    expect(page.evaluateCalls).toBe(0);
  });

  // A client-side redirect destroys the execution context; that is routine, and
  // must not fail the render.
  it('treats an unevaluatable page as not-yet-ready and keeps polling', async () => {
    const page = new FakePage();
    page.evaluateResults = [
      new Error('Execution context was destroyed'),
      new Error('Execution context was destroyed'),
      ready(null),
    ];

    const result = await waitForPageReady(
      asPage(page),
      idleTracker(),
      READINESS,
      Date.now() + 1_000,
      noopLogger,
    );

    expect(result.timedOut).toBe(false);
    expect(page.evaluateCalls).toBe(3);
  });

  it('remembers that the flag was seen even if the render then times out', async () => {
    const page = new FakePage();
    page.evaluateResults = [ready(false)];

    const result = await waitForPageReady(
      asPage(page),
      idleTracker(),
      READINESS,
      Date.now() + 40,
      noopLogger,
    );

    expect(result.usedPrerenderReady).toBe(true);
  });

  it('never sleeps past the deadline', async () => {
    const page = new FakePage();
    page.evaluateResults = [{ domReady: false, prerenderReady: null }];
    const started = Date.now();

    await waitForPageReady(
      asPage(page),
      idleTracker(),
      { ...READINESS, pageDoneCheckInterval: 10_000 },
      Date.now() + 50,
      noopLogger,
    );

    expect(Date.now() - started).toBeLessThan(500);
  });
});
