import type { Page, Request } from 'playwright-core';

import type { Logger } from '../logger.js';

/**
 * Resource types that never "finish".
 *
 * A WebSocket or EventSource connection stays open for the life of the page, so
 * counting it as in-flight means the network is never quiet and every render on
 * such a page burns the full timeout.
 */
const LONG_LIVED_RESOURCE_TYPES = new Set(['websocket', 'eventsource']);

interface RequestTracker {
  /** Requests started but not yet finished or failed. */
  inFlight: () => number;
  /** Timestamp of the last request start, finish or failure. */
  lastActivityAt: () => number;
  /** Detach the listeners. */
  stop: () => void;
}

/**
 * Count in-flight requests so the readiness loop can tell when the network has
 * gone quiet.
 *
 * Attach this before navigating, or the document request itself is missed.
 */
export function trackRequests(page: Page): RequestTracker {
  let inFlight = 0;
  let lastActivityAt = Date.now();

  const counts = (request: Request): boolean =>
    !LONG_LIVED_RESOURCE_TYPES.has(request.resourceType());

  const onRequest = (request: Request): void => {
    if (!counts(request)) {
      return;
    }
    inFlight++;
    lastActivityAt = Date.now();
  };

  const onSettled = (request: Request): void => {
    if (!counts(request)) {
      return;
    }
    inFlight--;
    lastActivityAt = Date.now();
  };

  page.on('request', onRequest);
  page.on('requestfinished', onSettled);
  page.on('requestfailed', onSettled);

  return {
    inFlight: () => inFlight,
    lastActivityAt: () => lastActivityAt,
    stop: () => {
      page.off('request', onRequest);
      page.off('requestfinished', onSettled);
      page.off('requestfailed', onSettled);
    },
  };
}

export interface ReadinessOptions {
  pageDoneCheckInterval: number;
  waitAfterLastRequest: number;
  renderReadyDelay: number;
}

interface ReadinessResult {
  /** The budget ran out before the page reported itself done. */
  timedOut: boolean;
  /** The page declared `window.renderReady` as a boolean, so we honored it. */
  usedReadyFlag: boolean;
}

interface PageState {
  domReady: boolean;
  renderReady: boolean | null;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Decide when a page is finished rendering.
 *
 * Two signals, and which one applies is up to the page:
 *
 * - **Network quiet.** No requests in flight, and none started or settled for
 *   `waitAfterLastRequest`. This is the only signal available for a site you
 *   don't control, which is why it is the fallback rather than the exception.
 * - **`window.renderReady`.** If the page defines it as a boolean, it is
 *   authoritative: we never capture before it turns true. Once it does, we
 *   capture as soon as the network is quiet or `renderReadyDelay` elapses,
 *   whichever comes first — so an app that knows it is done can cut a render
 *   short instead of waiting out its own trailing requests.
 *
 * Deliberately *not* `networkidle`: SPAs with long-polling, streaming or
 * keep-alive connections never reach it, which would pin every render at the
 * full timeout.
 *
 * A timeout is not an error. We return `timedOut: true` and let the caller
 * capture whatever rendered — partial content is usually more useful than
 * nothing, and the caller can still translate it into a status code.
 */
export async function waitForPageReady(
  page: Page,
  tracker: RequestTracker,
  options: ReadinessOptions,
  deadlineAt: number,
  logger: Logger,
): Promise<ReadinessResult> {
  let firstReadyAt: number | undefined;
  let sawReadyFlag = false;

  for (;;) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      logger.debug('Readiness budget exhausted; capturing as-is', {
        url: page.url(),
        inFlight: tracker.inFlight(),
        sawReadyFlag,
      });
      return { timedOut: true, usedReadyFlag: sawReadyFlag };
    }

    const state = await readPageState(page);

    // Nothing meaningful exists to capture until the document has parsed, and
    // an unreadable page (mid-navigation) is not done either.
    if (state?.domReady === true) {
      const declaresFlag = state.renderReady !== null;
      if (declaresFlag) {
        sawReadyFlag = true;
      }
      if (state.renderReady === true && firstReadyAt === undefined) {
        firstReadyAt = Date.now();
      }

      const quiet =
        tracker.inFlight() <= 0 &&
        Date.now() - tracker.lastActivityAt() >= options.waitAfterLastRequest;

      if (!declaresFlag && quiet) {
        return { timedOut: false, usedReadyFlag: false };
      }

      if (state.renderReady === true) {
        const readyFor = firstReadyAt === undefined ? 0 : Date.now() - firstReadyAt;
        if (quiet || readyFor >= options.renderReadyDelay) {
          return { timedOut: false, usedReadyFlag: true };
        }
      }
    }

    await sleep(Math.min(options.pageDoneCheckInterval, remaining));
  }
}

/**
 * Read both readiness signals in one round trip.
 *
 * Returns `undefined` when the page cannot be evaluated — which happens
 * routinely, not exceptionally: a client-side redirect destroys the execution
 * context mid-poll. Treating that as "not ready yet" and polling again is
 * correct; treating it as an error would fail renders that are merely navigating.
 */
async function readPageState(page: Page): Promise<PageState | undefined> {
  try {
    return await page.evaluate((): PageState => {
      const flag = (window as unknown as { renderReady?: unknown }).renderReady;
      return {
        domReady: document.readyState !== 'loading',
        // Normalized in-page so a non-boolean value (or an unserializable one)
        // can never cross the boundary.
        renderReady: typeof flag === 'boolean' ? flag : null,
      };
    });
  } catch {
    return undefined;
  }
}
