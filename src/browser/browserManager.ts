import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from 'playwright-core';

import type { BrowserConfig } from '../config.js';
import { BrowserLaunchError, BrowserUnavailableError, errorMessage } from '../errors.js';
import type { Logger } from '../logger.js';

import { buildChromeArgs, stripHeadlessMarker } from './chromeArgs.js';

const DRAIN_TIMEOUT_MS = 30_000;
const DRAIN_POLL_MS = 100;
const LAUNCH_MAX_ATTEMPTS = 3;
const LAUNCH_RETRY_DELAY_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Called as the browser moves in and out of being able to serve renders. Wire
 * these to a readiness probe so a process reports not-ready while relaunching,
 * without the manager needing to know anything about your HTTP layer.
 */
export interface AvailabilityHooks {
  onUnavailable: () => void;
  onAvailable: () => void;
}

export interface BrowserManagerOptions {
  config: BrowserConfig;
  logger: Logger;
  availability?: AvailabilityHooks;
  /**
   * Called when Chromium cannot be relaunched at all. Nothing will render after
   * this point, so a long-running process should log loudly and exit.
   */
  onFatal?: (error: BrowserLaunchError) => void;
}

export interface BrowserStats {
  ready: boolean;
  inFlight: number;
  renderCount: number;
  /** ms since the current browser process was launched, or 0 when down. */
  uptimeMs: number;
}

export interface BrowserManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  withPage<T>(fn: (page: Page) => Promise<T>, contextOptions?: BrowserContextOptions): Promise<T>;
  isReady(): boolean;
  stats(): BrowserStats;
}

/**
 * Owns a single headless Chromium process.
 *
 * Each render gets its own fresh `BrowserContext` — not merely a fresh page — so
 * it has a real, private cookie jar and `document.cookie` behaves exactly as it
 * would in a browser, with no leakage between renders. The tradeoff is that the
 * HTTP cache is not shared across renders; that is deliberate, and reverting it
 * reintroduces cross-render cookie bleed.
 *
 * Recovery is local. A hung render aborts only its own context. The browser is
 * relaunched when it crosses a render-count or age threshold, or when it
 * disconnects unexpectedly. A render arriving mid-relaunch waits for the fresh
 * browser rather than failing immediately, bounded by `relaunchWaitMs`.
 *
 * There is deliberately no concurrency limit here: `inFlight` exists only so a
 * recycle can drain before killing the process. Back-pressure is the caller's
 * responsibility.
 */
export function createBrowserManager(options: BrowserManagerOptions): BrowserManager {
  const { config, logger, availability, onFatal } = options;

  let browser: Browser | undefined;
  let defaultUserAgent: string | undefined;
  let inFlight = 0;
  let renderCount = 0;
  let startedAt = 0;
  let isRelaunching = false;
  let isStopping = false;
  let fatalError: BrowserLaunchError | undefined;
  // The in-flight relaunch, so renders arriving mid-relaunch await the same one
  // instead of being rejected. Cleared once the browser is back up.
  let relaunchPromise: Promise<void> | undefined;

  async function launch(): Promise<void> {
    const launched = await chromium.launch({
      ...(config.chromePath !== undefined ? { executablePath: config.chromePath } : {}),
      headless: true,
      args: buildChromeArgs(config),
    });

    // A relaunch already in flight when stop() was called would otherwise leak
    // this process: nothing holds a reference to it once we return.
    if (isStopping) {
      await launched.close().catch(() => {});
      return;
    }

    browser = launched;
    renderCount = 0;
    startedAt = Date.now();
    launched.on('disconnected', onDisconnected);

    defaultUserAgent = await resolveDefaultUserAgent(launched);
    logger.info('Browser launched', { version: launched.version(), userAgent: defaultUserAgent });
  }

  /**
   * Read Chromium's own user-agent once per launch so contexts can present a
   * non-headless one by default. Best-effort: on failure we simply leave the
   * context to use whatever Chromium reports.
   */
  async function resolveDefaultUserAgent(target: Browser): Promise<string | undefined> {
    let context: BrowserContext | undefined;
    try {
      context = await target.newContext();
      const page = await context.newPage();
      const userAgent = await page.evaluate(() => navigator.userAgent);
      return stripHeadlessMarker(userAgent);
    } catch (error) {
      logger.debug('Could not read the default user agent', { error: errorMessage(error) });
      return undefined;
    } finally {
      if (context) {
        await context.close().catch(() => {});
      }
    }
  }

  function onDisconnected(): void {
    // A deliberate close (recycle or stop) is handled by whoever asked for it;
    // only an unexpected disconnect — a crash or an OOM kill — needs recovery.
    if (isStopping || isRelaunching) {
      return;
    }
    logger.warn('Browser disconnected unexpectedly; relaunching');
    browser = undefined;
    void recycle('unexpected disconnect');
  }

  async function closeBrowser(): Promise<void> {
    if (!browser) {
      return;
    }
    const current = browser;
    browser = undefined;
    current.off('disconnected', onDisconnected);
    await current
      .close()
      .catch(error => logger.error('Error closing browser', { error: errorMessage(error) }));
  }

  /**
   * Wait for in-flight renders to finish before killing the process, so a
   * recycle never truncates a response. Bounded, because a genuinely stuck page
   * must not block the recycle forever.
   */
  async function drain(): Promise<void> {
    const start = Date.now();
    while (inFlight > 0) {
      if (Date.now() - start > DRAIN_TIMEOUT_MS) {
        logger.warn('Drain timed out; relaunching anyway', { inFlight });
        return;
      }
      await sleep(DRAIN_POLL_MS);
    }
  }

  async function launchWithRetry(): Promise<void> {
    for (let attempt = 1; attempt <= LAUNCH_MAX_ATTEMPTS; attempt++) {
      try {
        await launch();
        return;
      } catch (error) {
        logger.error('Browser launch failed', {
          attempt,
          of: LAUNCH_MAX_ATTEMPTS,
          error: errorMessage(error),
        });
        if (attempt < LAUNCH_MAX_ATTEMPTS) {
          await sleep(LAUNCH_RETRY_DELAY_MS);
        }
      }
    }
    throw new BrowserLaunchError(
      `Could not launch Chromium after ${LAUNCH_MAX_ATTEMPTS} attempts. ` +
        'Install a browser with `npx playwright install chromium`, or point ' +
        '`chromePath` / CHROME_PATH at an existing Chrome or Chromium binary.',
    );
  }

  function recycle(reason: string): Promise<void> {
    if (isRelaunching) {
      return relaunchPromise ?? Promise.resolve();
    }
    isRelaunching = true;
    availability?.onUnavailable();
    logger.info('Recycling browser', { reason });

    relaunchPromise = (async () => {
      try {
        await drain();
        await closeBrowser();
        if (isStopping) {
          return;
        }
        await launchWithRetry();
      } catch (error) {
        // Never reject: renders waiting on this promise would become unhandled
        // rejections. Record the failure instead and let withPage report it.
        fatalError =
          error instanceof BrowserLaunchError
            ? error
            : new BrowserLaunchError(errorMessage(error), { cause: error });
        logger.error('Browser is permanently unavailable', { error: fatalError.message });
        onFatal?.(fatalError);
      } finally {
        isRelaunching = false;
        relaunchPromise = undefined;
        availability?.onAvailable();
      }
    })();

    return relaunchPromise;
  }

  /**
   * Wait for an in-progress relaunch, bounded by `relaunchWaitMs`, so a render
   * queued behind a recycle succeeds instead of failing. If the wait elapses —
   * a stuck drain or launch — give up so the caller can retry rather than
   * hanging indefinitely.
   */
  async function waitForRelaunch(): Promise<void> {
    const pending = relaunchPromise;
    if (!pending) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new BrowserUnavailableError('Timed out waiting for the browser to relaunch')),
        config.relaunchWaitMs,
      );
    });
    try {
      await Promise.race([pending, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  function maybeRecycle(): void {
    if (isRelaunching || isStopping || !browser) {
      return;
    }
    if (renderCount >= config.recycleAfterRenders) {
      void recycle(`reached ${renderCount} renders`);
    } else if (Date.now() - startedAt >= config.recycleAfterMs) {
      void recycle('reached the age threshold');
    }
  }

  function throwIfFatal(): void {
    if (fatalError !== undefined) {
      throw fatalError;
    }
  }

  async function withPage<T>(
    fn: (page: Page) => Promise<T>,
    contextOptions: BrowserContextOptions = {},
  ): Promise<T> {
    throwIfFatal();
    if (isStopping) {
      throw new BrowserUnavailableError('The browser manager is shutting down');
    }
    // Waiting happens before inFlight is incremented, so a render queued behind
    // a relaunch can never block that relaunch's own drain.
    if (isRelaunching) {
      await waitForRelaunch();
    }
    // Checked again: the relaunch we just waited on may itself have failed.
    // Reading through a function is deliberate — TypeScript narrows `fatalError`
    // to `undefined` after the check above and does not widen it back across the
    // await, even though `recycle` can assign it in the meantime.
    throwIfFatal();

    const current = browser;
    if (isRelaunching || !current) {
      throw new BrowserUnavailableError('The browser is relaunching');
    }

    inFlight++;
    let context: BrowserContext | undefined;
    try {
      let page: Page;
      try {
        context = await current.newContext({
          ...(defaultUserAgent !== undefined ? { userAgent: defaultUserAgent } : {}),
          ignoreHTTPSErrors: true,
          serviceWorkers: 'block',
          ...contextOptions,
        });
        page = await context.newPage();
      } catch (error) {
        // Creating the context or page is browser infrastructure, not rendering.
        // If the browser dies here — a crash landing just after the check above —
        // report it as unavailability so the caller retries instead of counting
        // it as a failed render.
        throw new BrowserUnavailableError(
          `The browser became unavailable while preparing a page: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      return await fn(page);
    } finally {
      if (context) {
        await context
          .close()
          .catch(error => logger.error('Error closing context', { error: errorMessage(error) }));
      }
      inFlight--;
      renderCount++;
      maybeRecycle();
    }
  }

  return {
    start: () => launchWithRetry(),
    stop: async () => {
      // Deliberately does not await an in-flight relaunch: a stuck launch would
      // make shutdown hang forever. `launch` discards any browser that arrives
      // after this point, so there is nothing to leak.
      isStopping = true;
      await closeBrowser();
    },
    withPage,
    isReady: () =>
      !isRelaunching && !isStopping && fatalError === undefined && browser !== undefined,
    stats: () => ({
      ready: !isRelaunching && !isStopping && fatalError === undefined && browser !== undefined,
      inFlight,
      renderCount,
      uptimeMs: browser ? Date.now() - startedAt : 0,
    }),
  };
}
