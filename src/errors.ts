/**
 * Error taxonomy for renderready.
 *
 * Every error carries a stable machine-readable `code` so callers can branch
 * without string-matching messages, and an optional `statusCode` for the errors
 * whose HTTP mapping is intrinsic (a malformed URL is always a 400). Errors
 * whose status is configurable — a failed render maps to
 * `renderErrorStatusCode` — deliberately leave `statusCode` undefined and let
 * the server decide.
 */

export type RenderReadyErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_URL'
  | 'URL_NOT_ALLOWED'
  | 'BROWSER_UNAVAILABLE'
  | 'BROWSER_LAUNCH_FAILED'
  | 'RENDER_FAILED';

/** Base class for every error this package throws deliberately. */
export abstract class RenderReadyError extends Error {
  abstract readonly code: RenderReadyErrorCode;

  /** Set only where the HTTP mapping is intrinsic to the error. */
  readonly statusCode: number | undefined;

  constructor(message: string, options?: { cause?: unknown; statusCode?: number }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.statusCode = options?.statusCode;
  }
}

/** Configuration failed validation at startup. */
export class ConfigError extends RenderReadyError {
  readonly code = 'INVALID_CONFIG' as const;
}

/** The requested URL is absent, malformed, or not an http(s) URL. */
export class InvalidUrlError extends RenderReadyError {
  constructor(message: string) {
    super(message, { statusCode: 400 });
  }
  readonly code = 'INVALID_URL' as const;
}

/**
 * The URL is well-formed but excluded by `allowedDomains` / `blockedDomains`.
 * 404 rather than 403, matching the prerender package's whitelist/blacklist
 * plugins — it should look like the resource simply isn't there.
 */
export class UrlNotAllowedError extends RenderReadyError {
  constructor(message: string) {
    super(message, { statusCode: 404 });
  }
  readonly code = 'URL_NOT_ALLOWED' as const;
}

/**
 * The browser is mid-relaunch (recycle or crash recovery) and did not come back
 * within `relaunchWaitMs`. Transient by nature — the caller should retry.
 */
export class BrowserUnavailableError extends RenderReadyError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { ...options, statusCode: 503 });
  }
  readonly code = 'BROWSER_UNAVAILABLE' as const;
}

/**
 * Chromium could not be launched at all, after retries. Fatal: nothing this
 * process does afterwards will render anything.
 */
export class BrowserLaunchError extends RenderReadyError {
  readonly code = 'BROWSER_LAUNCH_FAILED' as const;
}

/** Navigation or content extraction failed for this particular page. */
export class RenderError extends RenderReadyError {
  readonly code = 'RENDER_FAILED' as const;
}

/** Narrowing helper for callers that catch `unknown`. */
export function isRenderReadyError(error: unknown): error is RenderReadyError {
  return error instanceof RenderReadyError;
}

/** Best-effort message extraction for arbitrary thrown values. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
