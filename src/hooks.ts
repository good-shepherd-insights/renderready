import type { Page } from 'playwright-core';

/**
 * Lifecycle hooks.
 *
 * The behaviours nearly everyone wants — stripping scripts, reading meta status
 * codes, allow/block lists, basic auth — are configuration flags, because nobody
 * should have to wire those up by hand. Hooks exist for what a package cannot
 * anticipate: caching, metrics, authentication schemes, per-site fixups.
 *
 * A hook that throws fails the render. Return a promise and it will be awaited.
 */
export interface Hooks {
  /**
   * Before any browser work. The cheapest place to reject a request, and the
   * only place that runs before a browser page is claimed.
   *
   * Throw to abort the render — throw a `RenderReadyError` subclass to control
   * the HTTP status.
   */
  onRequest?: (context: RenderRequestContext) => void | Promise<void>;

  /**
   * After the page exists but before navigation. Use it for `addInitScript`,
   * extra headers, cookies, or your own `page.route` handlers.
   */
  onPageCreated?: (page: Page, context: RenderRequestContext) => void | Promise<void>;

  /**
   * After the HTML is captured and the built-in transforms have run. Mutate
   * `html`, `statusCode` or `headers` to change what the caller receives.
   *
   * This is where a cache would write its entry — after script stripping, so
   * what you store is what you would serve.
   */
  onPageLoaded?: (context: RenderedContext) => void | Promise<void>;

  /**
   * Always called, once, whether the render succeeded or failed. Intended for
   * metrics. Errors thrown here are swallowed and logged: observability must not
   * be able to fail a render.
   */
  onRenderFinished?: (info: RenderFinishedInfo) => void | Promise<void>;
}

export interface RenderRequestContext {
  /** The normalized URL being rendered. */
  readonly url: string;
  /** Unique per render, for correlating logs and provenance meta tags. */
  readonly renderId: string;
  readonly startedAt: Date;
}

export interface RenderedContext extends RenderRequestContext {
  html: string;
  statusCode: number;
  headers: Record<string, string>;
  /** The requested URL answered with a 3xx that was not followed. */
  readonly isRedirect: boolean;
  /** The render budget ran out; `html` is a partial capture. */
  readonly timedOut: boolean;
}

export interface RenderFinishedInfo extends RenderRequestContext {
  readonly durationMs: number;
  /** Absent when the render failed before a status was determined. */
  readonly statusCode?: number;
  readonly isRedirect?: boolean;
  readonly timedOut?: boolean;
  /** Set when the render failed. */
  readonly error?: unknown;
}
