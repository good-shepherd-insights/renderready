import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBrowserManager, type BrowserManager } from '../../src/browser/browserManager.js';
import type { BrowserConfig } from '../../src/config.js';
import { BrowserLaunchError, BrowserUnavailableError } from '../../src/errors.js';
import { noopLogger } from '../../src/logger.js';

vi.mock('playwright-core', () => ({
  chromium: { launch: vi.fn() },
}));

const launchMock = vi.mocked(chromium.launch);

const config = (overrides: Partial<BrowserConfig> = {}): BrowserConfig => ({
  extraChromeArgs: [],
  blockImages: true,
  blockFonts: true,
  recycleAfterRenders: 300,
  recycleAfterMs: 600_000,
  relaunchWaitMs: 30_000,
  ...overrides,
});

/**
 * Stand-ins for Playwright's objects. Hand-rolled rather than auto-mocked so a
 * test can drive the interesting transitions directly — notably
 * `emitDisconnected()`, which is how a crash is simulated.
 */
class FakeContext {
  closed = false;
  readonly pages: FakePage[] = [];
  readonly options: Record<string, unknown>;

  constructor(options: Record<string, unknown>) {
    this.options = options;
  }

  newPage = vi.fn(async (): Promise<FakePage> => {
    const page = new FakePage();
    this.pages.push(page);
    return page;
  });

  close = vi.fn(async (): Promise<void> => {
    this.closed = true;
  });
}

class FakePage {
  // The manager reads navigator.userAgent once per launch via page.evaluate.
  evaluate = vi.fn(
    async (): Promise<string> => 'Mozilla/5.0 HeadlessChrome/140.0.0.0 Safari/537.36',
  );
}

class FakeBrowser {
  readonly contexts: FakeContext[] = [];
  closed = false;
  private listeners: (() => void)[] = [];
  newContextError: Error | undefined;

  version = vi.fn(() => '140.0.0.0');

  newContext = vi.fn(async (options: Record<string, unknown> = {}): Promise<FakeContext> => {
    if (this.newContextError) {
      throw this.newContextError;
    }
    const context = new FakeContext(options);
    this.contexts.push(context);
    return context;
  });

  close = vi.fn(async (): Promise<void> => {
    this.closed = true;
  });

  on = vi.fn((event: string, listener: () => void) => {
    if (event === 'disconnected') {
      this.listeners.push(listener);
    }
  });

  off = vi.fn((event: string, listener: () => void) => {
    if (event === 'disconnected') {
      this.listeners = this.listeners.filter(item => item !== listener);
    }
  });

  /** Simulate Chromium dying underneath us. */
  emitDisconnected(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  /** The context created for actual rendering, skipping the UA-probe context. */
  get renderContexts(): FakeContext[] {
    return this.contexts.slice(1);
  }
}

function queueBrowsers(count: number): FakeBrowser[] {
  const browsers = Array.from({ length: count }, () => new FakeBrowser());
  let index = 0;
  launchMock.mockImplementation(async () => {
    const next = browsers[Math.min(index, browsers.length - 1)];
    index++;
    return next as unknown as Awaited<ReturnType<typeof chromium.launch>>;
  });
  return browsers;
}

/** Let queued microtasks settle without advancing time. */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

let manager: BrowserManager | undefined;

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

describe('createBrowserManager', () => {
  beforeEach(() => {
    launchMock.mockReset();
  });

  describe('launching', () => {
    it('launches headless Chromium with the configured args', async () => {
      queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });

      await manager.start();

      expect(launchMock).toHaveBeenCalledTimes(1);
      const args = launchMock.mock.calls[0]?.[0];
      expect(args?.headless).toBe(true);
      expect(args?.args).toContain('--no-sandbox');
      expect(args?.args).toContain('--disable-dev-shm-usage');
      expect(args?.args).toContain('--blink-settings=imagesEnabled=false');
      expect(args?.args).toContain('--disable-remote-fonts');
      expect(manager.isReady()).toBe(true);
    });

    it('passes executablePath only when chromePath is set', async () => {
      queueBrowsers(2);

      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();
      expect(launchMock.mock.calls[0]?.[0]).not.toHaveProperty('executablePath');
      await manager.stop();

      manager = createBrowserManager({
        config: config({ chromePath: '/usr/bin/chromium' }),
        logger: noopLogger,
      });
      await manager.start();
      expect(launchMock.mock.calls[1]?.[0]?.executablePath).toBe('/usr/bin/chromium');
    });

    it('appends extra args after the defaults', async () => {
      queueBrowsers(1);
      manager = createBrowserManager({
        config: config({ extraChromeArgs: ['--proxy-server=http://p:8080'] }),
        logger: noopLogger,
      });

      await manager.start();

      const args = launchMock.mock.calls[0]?.[0]?.args ?? [];
      expect(args.at(-1)).toBe('--proxy-server=http://p:8080');
    });

    it('omits the image and font flags when blocking is disabled', async () => {
      queueBrowsers(1);
      manager = createBrowserManager({
        config: config({ blockImages: false, blockFonts: false }),
        logger: noopLogger,
      });

      await manager.start();

      const args = launchMock.mock.calls[0]?.[0]?.args ?? [];
      expect(args).not.toContain('--blink-settings=imagesEnabled=false');
      expect(args).not.toContain('--disable-remote-fonts');
    });

    it('retries a failing launch, then reports it as fatal', async () => {
      vi.useFakeTimers();
      try {
        launchMock.mockRejectedValue(new Error('no binary'));
        manager = createBrowserManager({ config: config(), logger: noopLogger });

        const started = manager.start();
        const assertion = expect(started).rejects.toThrow(BrowserLaunchError);
        await vi.runAllTimersAsync();
        await assertion;

        expect(launchMock).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('names the remedy in the launch failure message', async () => {
      vi.useFakeTimers();
      try {
        launchMock.mockRejectedValue(new Error('no binary'));
        manager = createBrowserManager({ config: config(), logger: noopLogger });

        const started = manager.start();
        const assertion = expect(started).rejects.toThrow(/playwright install chromium/);
        await vi.runAllTimersAsync();
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('recovers if an early launch attempt fails but a later one succeeds', async () => {
      vi.useFakeTimers();
      try {
        const browser = new FakeBrowser();
        launchMock
          .mockRejectedValueOnce(new Error('transient'))
          .mockResolvedValue(browser as unknown as Awaited<ReturnType<typeof chromium.launch>>);
        manager = createBrowserManager({ config: config(), logger: noopLogger });

        const started = manager.start();
        await vi.runAllTimersAsync();
        await started;

        expect(launchMock).toHaveBeenCalledTimes(2);
        expect(manager.isReady()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a non-headless user agent to contexts', async () => {
      const [browser] = queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();

      await manager.withPage(async () => undefined);

      const options = browser?.renderContexts[0]?.options;
      expect(options?.userAgent).toBe('Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36');
    });

    it('still launches when the user-agent probe fails', async () => {
      const browser = new FakeBrowser();
      browser.newContext.mockRejectedValueOnce(new Error('probe failed'));
      launchMock.mockResolvedValue(
        browser as unknown as Awaited<ReturnType<typeof chromium.launch>>,
      );
      manager = createBrowserManager({ config: config(), logger: noopLogger });

      await manager.start();

      expect(manager.isReady()).toBe(true);
    });
  });

  describe('withPage', () => {
    it('gives the callback a page and returns its result', async () => {
      queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();

      const result = await manager.withPage(async page => {
        expect(page).toBeDefined();
        return 'rendered';
      });

      expect(result).toBe('rendered');
    });

    it('creates a private context per render and always closes it', async () => {
      const [browser] = queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();

      await manager.withPage(async () => undefined);
      await manager.withPage(async () => undefined);

      expect(browser?.renderContexts).toHaveLength(2);
      expect(browser?.renderContexts.every(context => context.closed)).toBe(true);
    });

    // Cookie isolation is the whole reason for a fresh context rather than a
    // fresh page; two concurrent renders must never share a jar.
    it('isolates concurrent renders in separate contexts', async () => {
      const [browser] = queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();

      let releaseFirst: (() => void) | undefined;
      const first = manager.withPage(async () => {
        await new Promise<void>(resolve => {
          releaseFirst = resolve;
        });
      });
      await flush();
      const second = manager.withPage(async () => undefined);
      await second;
      releaseFirst?.();
      await first;

      expect(browser?.renderContexts).toHaveLength(2);
      expect(browser?.renderContexts[0]).not.toBe(browser?.renderContexts[1]);
    });

    it('blocks service workers and ignores certificate errors', async () => {
      const [browser] = queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();

      await manager.withPage(async () => undefined);

      const options = browser?.renderContexts[0]?.options;
      expect(options?.serviceWorkers).toBe('block');
      expect(options?.ignoreHTTPSErrors).toBe(true);
    });

    it('lets per-render context options override the defaults', async () => {
      const [browser] = queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();

      await manager.withPage(async () => undefined, {
        userAgent: 'CustomAgent/1.0',
        viewport: { width: 800, height: 600 },
      });

      const options = browser?.renderContexts[0]?.options;
      expect(options?.userAgent).toBe('CustomAgent/1.0');
      expect(options?.viewport).toEqual({ width: 800, height: 600 });
    });

    it('closes the context even when the callback throws, and propagates', async () => {
      const [browser] = queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();

      await expect(
        manager.withPage(async () => Promise.reject(new Error('render blew up'))),
      ).rejects.toThrow('render blew up');
      expect(browser?.renderContexts[0]?.closed).toBe(true);
    });

    // A crash landing between the readiness check and context creation is an
    // outage, not a render failure — the distinction decides whether a caller
    // burns a retry.
    it('reports a mid-setup crash as unavailability rather than a render error', async () => {
      const [browser] = queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();
      if (browser) {
        browser.newContextError = new Error('Target closed');
      }

      await expect(manager.withPage(async () => undefined)).rejects.toThrow(
        BrowserUnavailableError,
      );
    });

    it('preserves the underlying error as the cause', async () => {
      const [browser] = queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();
      const underlying = new Error('Target closed');
      if (browser) {
        browser.newContextError = underlying;
      }

      await expect(manager.withPage(async () => undefined)).rejects.toMatchObject({
        cause: underlying,
      });
    });

    it('refuses to render once stopped', async () => {
      queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();
      await manager.stop();

      await expect(manager.withPage(async () => undefined)).rejects.toThrow(/shutting down/);
    });

    it('survives a context that fails to close', async () => {
      const [browser] = queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();
      await manager.withPage(async () => undefined);
      const context = browser?.renderContexts[0];
      context?.close.mockRejectedValueOnce(new Error('already gone'));

      await expect(manager.withPage(async () => 'ok')).resolves.toBe('ok');
    });
  });

  describe('recycling', () => {
    it('relaunches after the configured number of renders', async () => {
      const browsers = queueBrowsers(2);
      manager = createBrowserManager({
        config: config({ recycleAfterRenders: 2 }),
        logger: noopLogger,
      });
      await manager.start();

      await manager.withPage(async () => undefined);
      expect(launchMock).toHaveBeenCalledTimes(1);

      await manager.withPage(async () => undefined);
      await flush();
      await flush();

      expect(launchMock).toHaveBeenCalledTimes(2);
      expect(browsers[0]?.closed).toBe(true);
    });

    it('relaunches once the browser reaches the age threshold', async () => {
      queueBrowsers(2);
      manager = createBrowserManager({ config: config({ recycleAfterMs: 0 }), logger: noopLogger });
      await manager.start();

      await manager.withPage(async () => undefined);
      await flush();
      await flush();

      expect(launchMock).toHaveBeenCalledTimes(2);
    });

    it('resets the render count for the fresh browser', async () => {
      queueBrowsers(3);
      manager = createBrowserManager({
        config: config({ recycleAfterRenders: 2 }),
        logger: noopLogger,
      });
      await manager.start();

      await manager.withPage(async () => undefined);
      await manager.withPage(async () => undefined);
      await flush();
      await flush();

      expect(manager.stats().renderCount).toBe(0);
    });

    it('waits for in-flight renders before killing the browser', async () => {
      const browsers = queueBrowsers(2);
      manager = createBrowserManager({
        config: config({ recycleAfterRenders: 1 }),
        logger: noopLogger,
      });
      await manager.start();

      let release: (() => void) | undefined;
      const slow = manager.withPage(async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      });
      await flush();

      // A second render trips the threshold and starts the recycle while the
      // first is still running.
      await manager.withPage(async () => undefined);
      await flush();

      expect(browsers[0]?.closed).toBe(false);

      release?.();
      await slow;
      await vi.waitFor(() => {
        expect(browsers[0]?.closed).toBe(true);
      });
    });

    it('relaunches after an unexpected disconnect', async () => {
      const browsers = queueBrowsers(2);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();

      browsers[0]?.emitDisconnected();
      await vi.waitFor(() => {
        expect(launchMock).toHaveBeenCalledTimes(2);
      });
      expect(manager.isReady()).toBe(true);
    });

    it('ignores the disconnect event fired by its own shutdown', async () => {
      const browsers = queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();

      await manager.stop();
      browsers[0]?.emitDisconnected();
      await flush();

      expect(launchMock).toHaveBeenCalledTimes(1);
    });

    it('collapses concurrent recycles into one relaunch', async () => {
      const browsers = queueBrowsers(2);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();

      browsers[0]?.emitDisconnected();
      browsers[0]?.emitDisconnected();
      browsers[0]?.emitDisconnected();
      await vi.waitFor(() => {
        expect(manager?.isReady()).toBe(true);
      });

      expect(launchMock).toHaveBeenCalledTimes(2);
    });

    it('reports not-ready for the duration of a relaunch, then ready again', async () => {
      const browsers = queueBrowsers(2);
      const availability = { onUnavailable: vi.fn(), onAvailable: vi.fn() };
      manager = createBrowserManager({ config: config(), logger: noopLogger, availability });
      await manager.start();

      browsers[0]?.emitDisconnected();
      expect(availability.onUnavailable).toHaveBeenCalledTimes(1);
      expect(manager.isReady()).toBe(false);

      await vi.waitFor(() => {
        expect(availability.onAvailable).toHaveBeenCalledTimes(1);
      });
      expect(manager.isReady()).toBe(true);
    });

    it('lets a render arriving mid-relaunch wait for the fresh browser', async () => {
      const browsers = queueBrowsers(2);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();

      browsers[0]?.emitDisconnected();
      const rendered = await manager.withPage(async () => 'rendered after relaunch');

      expect(rendered).toBe('rendered after relaunch');
      expect(browsers[1]?.renderContexts).toHaveLength(1);
    });

    it('gives up waiting for a stuck relaunch after relaunchWaitMs', async () => {
      vi.useFakeTimers();
      try {
        const browsers = [new FakeBrowser(), new FakeBrowser()];
        let neverResolve: (() => void) | undefined;
        launchMock
          .mockResolvedValueOnce(
            browsers[0] as unknown as Awaited<ReturnType<typeof chromium.launch>>,
          )
          .mockImplementationOnce(
            () =>
              new Promise(resolve => {
                neverResolve = () =>
                  resolve(browsers[1] as unknown as Awaited<ReturnType<typeof chromium.launch>>);
              }),
          );
        manager = createBrowserManager({
          config: config({ relaunchWaitMs: 1_000 }),
          logger: noopLogger,
        });
        await manager.start();

        browsers[0]?.emitDisconnected();
        await Promise.resolve();

        const pending = manager.withPage(async () => undefined);
        const assertion = expect(pending).rejects.toThrow(BrowserUnavailableError);
        await vi.advanceTimersByTimeAsync(1_100);
        await assertion;

        expect(neverResolve).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a permanently failing relaunch as fatal to every later render', async () => {
      vi.useFakeTimers();
      try {
        const browser = new FakeBrowser();
        launchMock
          .mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.launch>>)
          .mockRejectedValue(new Error('binary vanished'));
        const onFatal = vi.fn();
        manager = createBrowserManager({ config: config(), logger: noopLogger, onFatal });
        await manager.start();

        browser.emitDisconnected();
        await vi.runAllTimersAsync();

        expect(onFatal).toHaveBeenCalledTimes(1);
        expect(onFatal.mock.calls[0]?.[0]).toBeInstanceOf(BrowserLaunchError);
        expect(manager.isReady()).toBe(false);
        await expect(manager.withPage(async () => undefined)).rejects.toThrow(BrowserLaunchError);
      } finally {
        vi.useRealTimers();
      }
    });

    // A rejected relaunch promise would surface as an unhandled rejection in
    // every render waiting on it, which crashes the process on modern Node.
    it('does not produce an unhandled rejection when a relaunch fails', async () => {
      vi.useFakeTimers();
      const onUnhandled = vi.fn();
      process.on('unhandledRejection', onUnhandled);
      try {
        const browser = new FakeBrowser();
        launchMock
          .mockResolvedValueOnce(browser as unknown as Awaited<ReturnType<typeof chromium.launch>>)
          .mockRejectedValue(new Error('binary vanished'));
        manager = createBrowserManager({ config: config(), logger: noopLogger });
        await manager.start();

        browser.emitDisconnected();
        await vi.runAllTimersAsync();
        // Not flush(): setImmediate is faked here, so it would never fire.
        await Promise.resolve();

        expect(onUnhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', onUnhandled);
        vi.useRealTimers();
      }
    });
  });

  describe('stats', () => {
    it('reports readiness, in-flight count and render count', async () => {
      queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();

      expect(manager.stats()).toMatchObject({ ready: true, inFlight: 0, renderCount: 0 });

      await manager.withPage(async () => undefined);
      expect(manager.stats()).toMatchObject({ inFlight: 0, renderCount: 1 });
    });

    it('counts a render while it is in flight', async () => {
      queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();

      let release: (() => void) | undefined;
      const pending = manager.withPage(async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      });
      await flush();

      expect(manager.stats().inFlight).toBe(1);

      release?.();
      await pending;
      expect(manager.stats().inFlight).toBe(0);
    });

    it('reports zero uptime while the browser is down', async () => {
      queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });

      expect(manager.stats()).toMatchObject({ ready: false, uptimeMs: 0 });
    });
  });

  describe('stop', () => {
    it('closes the browser and reports not-ready', async () => {
      const [browser] = queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();

      await manager.stop();

      expect(browser?.closed).toBe(true);
      expect(manager.isReady()).toBe(false);
    });

    it('is safe to call before start and twice over', async () => {
      queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });

      await expect(manager.stop()).resolves.toBeUndefined();
      await expect(manager.stop()).resolves.toBeUndefined();
    });

    it('does not relaunch when stopping interrupts a recycle', async () => {
      const browsers = queueBrowsers(2);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();

      browsers[0]?.emitDisconnected();
      await manager.stop();
      await flush();

      expect(manager.isReady()).toBe(false);
    });

    it('survives a browser that fails to close', async () => {
      const [browser] = queueBrowsers(1);
      manager = createBrowserManager({ config: config(), logger: noopLogger });
      await manager.start();
      browser?.close.mockRejectedValueOnce(new Error('already dead'));

      await expect(manager.stop()).resolves.toBeUndefined();
    });
  });
});
