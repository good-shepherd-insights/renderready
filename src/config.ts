import { z } from 'zod';

import { ConfigError } from './errors.js';
import { LOG_LEVELS, type LogLevel, type Logger } from './logger.js';

/**
 * Playwright's request resource types, for `blockedResourceTypes`.
 * Mirrors https://playwright.dev/docs/api/class-request#request-resource-type.
 */
export const RESOURCE_TYPES = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'eventsource',
  'websocket',
  'manifest',
  'other',
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

/**
 * Everything you can pass to `start()`, `createServer()` or `createRenderer()`.
 * Flat and fully optional; `resolveConfig` turns it into the grouped
 * {@link RenderReadyConfig} the internals consume.
 *
 * Precedence is always `option ?? environment ?? default`. Note `??`, not `||`:
 * an explicit `0` or `false` is honored. With `||`, a deliberate `0` would fall
 * through to the default, making `waitAfterLastRequest: 0` impossible to set.
 */
export interface RenderReadyOptions {
  /** HTTP port to listen on. Env `PORT`. Default `3000`. */
  port?: number;
  /** Interface to bind. Env `HOST`. Default `0.0.0.0`. */
  host?: string;

  /**
   * Path to a Chromium/Chrome binary. Env `CHROME_PATH`. When unset, Playwright
   * resolves its own installed browser (`npx playwright install chromium`).
   */
  chromePath?: string;
  /** Extra Chromium command-line flags, appended to the defaults. */
  extraChromeArgs?: string[];
  /**
   * Disable image loading at the engine level. Default `true` — scripts are
   * stripped from the output anyway, so image bytes can never affect the
   * serialized DOM, and skipping decode/paint is a large CPU saving.
   */
  blockImages?: boolean;
  /** Disable webfont loading at the engine level. Default `true`. */
  blockFonts?: boolean;

  /** Relaunch the browser after this many renders. Env `RECYCLE_AFTER_RENDERS`. Default `300`. */
  recycleAfterRenders?: number;
  /** Relaunch the browser once it is this old, in ms. Env `RECYCLE_AFTER_MS`. Default `600000`. */
  recycleAfterMs?: number;
  /** How long a render waits for an in-progress relaunch. Env `RELAUNCH_WAIT_MS`. Default `30000`. */
  relaunchWaitMs?: number;

  /** Hard ceiling for a single render, in ms. Env `PAGE_LOAD_TIMEOUT`. Default `20000`. */
  pageLoadTimeout?: number;
  /** Readiness poll interval, in ms. Env `PAGE_DONE_CHECK_INTERVAL`. Default `500`. */
  pageDoneCheckInterval?: number;
  /** Network-quiet window before a page counts as done, in ms. Env `WAIT_AFTER_LAST_REQUEST`. Default `500`. */
  waitAfterLastRequest?: number;
  /**
   * Grace period after `window.renderReady` first turns true, in ms. Env
   * `RENDER_READY_DELAY`. Default `1000`.
   */
  renderReadyDelay?: number;
  /**
   * Follow a redirect on the requested URL instead of returning the 3xx.
   * Env `FOLLOW_REDIRECTS`. Default `false` — crawlers should see the redirect.
   */
  followRedirects?: boolean;
  /**
   * Status to report when the readiness wait times out. Env `TIMEOUT_STATUS_CODE`.
   * Default `null`, meaning keep whatever status the origin returned.
   */
  timeoutStatusCode?: number | null;
  /** Status to report when a render fails outright. Env `RENDER_ERROR_STATUS_CODE`. Default `504`. */
  renderErrorStatusCode?: number;
  /** User-Agent for page requests. Env `USER_AGENT`. Default `null` (Chromium's own, suffixed). */
  userAgent?: string | null;
  /** Viewport width. Env `VIEWPORT_WIDTH`. Default `1440`. */
  viewportWidth?: number;
  /** Viewport height. Env `VIEWPORT_HEIGHT`. Default `718`. */
  viewportHeight?: number;
  /**
   * Headers sent to the origin on every request, so your app can detect the
   * renderer. Default `{ 'X-RenderReady': '1' }`.
   */
  originHeaders?: Record<string, string>;

  /** Strip `<script>` tags (keeping `application/ld+json`). Default `true`. */
  removeScriptTags?: boolean;
  /** Rewrite root-relative `src`/`href` to absolute URLs. Default `true`. */
  absoluteUrls?: boolean;
  /** Honor `<meta name="renderready-status-code">` / `renderready-header`. Default `true`. */
  metaStatusCode?: boolean;
  /** Inject `x-renderready-render-id` / `-render-at` meta tags. Default `false`. */
  injectRenderMeta?: boolean;

  /** Abort these resource types via request interception. Default `[]`. */
  blockedResourceTypes?: ResourceType[];
  /** Abort requests whose URL contains any of these substrings. Default `[]`. */
  blockedUrlPatterns?: string[];

  /** Only render these hostnames (and their subdomains). Env `ALLOWED_DOMAINS`. Default `[]` (all). */
  allowedDomains?: string[];
  /** Never render these hostnames (and their subdomains). Env `BLOCKED_DOMAINS`. Default `[]`. */
  blockedDomains?: string[];
  /**
   * Require HTTP basic auth on the render endpoint. Env `BASIC_AUTH_USERNAME` /
   * `BASIC_AUTH_PASSWORD`. Default `null` (open).
   */
  basicAuth?: { username: string; password: string } | null;

  /** Verbosity of the built-in logger. Env `LOG_LEVEL`. Default `info`. */
  logLevel?: LogLevel;
  /** Replace the built-in logger entirely. Not validated — bring anything compatible. */
  logger?: Logger;
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface BrowserConfig {
  /** Absent when Playwright should resolve its own installed Chromium. */
  chromePath?: string;
  extraChromeArgs: string[];
  blockImages: boolean;
  blockFonts: boolean;
  recycleAfterRenders: number;
  recycleAfterMs: number;
  relaunchWaitMs: number;
}

export interface RenderConfig {
  pageLoadTimeout: number;
  pageDoneCheckInterval: number;
  waitAfterLastRequest: number;
  renderReadyDelay: number;
  followRedirects: boolean;
  timeoutStatusCode: number | null;
  renderErrorStatusCode: number;
  userAgent: string | null;
  viewportWidth: number;
  viewportHeight: number;
  originHeaders: Record<string, string>;
  removeScriptTags: boolean;
  absoluteUrls: boolean;
  metaStatusCode: boolean;
  injectRenderMeta: boolean;
  blockedResourceTypes: ResourceType[];
  blockedUrlPatterns: string[];
}

export interface AccessConfig {
  allowedDomains: string[];
  blockedDomains: string[];
  basicAuth: { username: string; password: string } | null;
}

/** The validated, fully-populated configuration the internals consume. */
export interface RenderReadyConfig {
  server: ServerConfig;
  browser: BrowserConfig;
  render: RenderConfig;
  access: AccessConfig;
  logLevel: LogLevel;
}

export type Env = Record<string, string | undefined>;

function readString(env: Env, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readInt(env: Env, key: string): number | undefined {
  const raw = readString(env, key);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ConfigError(`Environment variable ${key} must be an integer, received "${raw}"`);
  }
  return parsed;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

function readBool(env: Env, key: string): boolean | undefined {
  const raw = readString(env, key)?.toLowerCase();
  if (raw === undefined) {
    return undefined;
  }
  if (TRUTHY.has(raw)) {
    return true;
  }
  if (FALSY.has(raw)) {
    return false;
  }
  throw new ConfigError(`Environment variable ${key} must be a boolean, received "${raw}"`);
}

function readList(env: Env, key: string): string[] | undefined {
  const raw = readString(env, key);
  if (raw === undefined) {
    return undefined;
  }
  const items = raw
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '');
  return items.length > 0 ? items : undefined;
}

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const httpStatus = z.number().int().min(100).max(599);

const configSchema = z.object({
  server: z.object({
    port: z.number().int().min(0).max(65535),
    host: z.string().min(1),
  }),
  browser: z.object({
    chromePath: z.string().min(1).optional(),
    extraChromeArgs: z.array(z.string()),
    blockImages: z.boolean(),
    blockFonts: z.boolean(),
    recycleAfterRenders: positiveInt,
    recycleAfterMs: positiveInt,
    relaunchWaitMs: positiveInt,
  }),
  render: z.object({
    pageLoadTimeout: positiveInt,
    pageDoneCheckInterval: positiveInt,
    waitAfterLastRequest: nonNegativeInt,
    renderReadyDelay: nonNegativeInt,
    followRedirects: z.boolean(),
    timeoutStatusCode: httpStatus.nullable(),
    renderErrorStatusCode: httpStatus,
    userAgent: z.string().min(1).nullable(),
    viewportWidth: positiveInt,
    viewportHeight: positiveInt,
    originHeaders: z.record(z.string(), z.string()),
    removeScriptTags: z.boolean(),
    absoluteUrls: z.boolean(),
    metaStatusCode: z.boolean(),
    injectRenderMeta: z.boolean(),
    blockedResourceTypes: z.array(z.enum(RESOURCE_TYPES)),
    blockedUrlPatterns: z.array(z.string().min(1)),
  }),
  access: z.object({
    allowedDomains: z.array(z.string().min(1)),
    blockedDomains: z.array(z.string().min(1)),
    basicAuth: z
      .object({
        username: z.string().min(1),
        password: z.string().min(1),
      })
      .nullable(),
  }),
  logLevel: z.enum(LOG_LEVELS),
});

export const DEFAULT_ORIGIN_HEADERS: Readonly<Record<string, string>> = { 'X-RenderReady': '1' };

/**
 * Merge options over environment over defaults, then validate the result once.
 *
 * Validating the merged shape (rather than the inputs) means an out-of-range
 * value is reported identically whether it arrived as an option or an env var.
 *
 * @throws {ConfigError} if any value is missing, malformed, or out of range.
 */
export function resolveConfig(
  options: RenderReadyOptions = {},
  env: Env = process.env,
): RenderReadyConfig {
  const envBasicAuthUser = readString(env, 'BASIC_AUTH_USERNAME');
  const envBasicAuthPassword = readString(env, 'BASIC_AUTH_PASSWORD');

  let basicAuth = options.basicAuth ?? null;
  if (
    basicAuth === null &&
    (envBasicAuthUser !== undefined || envBasicAuthPassword !== undefined)
  ) {
    if (envBasicAuthUser === undefined || envBasicAuthPassword === undefined) {
      throw new ConfigError(
        'BASIC_AUTH_USERNAME and BASIC_AUTH_PASSWORD must both be set, or neither',
      );
    }
    basicAuth = { username: envBasicAuthUser, password: envBasicAuthPassword };
  }

  const candidate = {
    server: {
      port: options.port ?? readInt(env, 'PORT') ?? 3000,
      host: options.host ?? readString(env, 'HOST') ?? '0.0.0.0',
    },
    browser: {
      chromePath: options.chromePath ?? readString(env, 'CHROME_PATH'),
      extraChromeArgs: options.extraChromeArgs ?? readList(env, 'EXTRA_CHROME_ARGS') ?? [],
      blockImages: options.blockImages ?? readBool(env, 'BLOCK_IMAGES') ?? true,
      blockFonts: options.blockFonts ?? readBool(env, 'BLOCK_FONTS') ?? true,
      recycleAfterRenders:
        options.recycleAfterRenders ?? readInt(env, 'RECYCLE_AFTER_RENDERS') ?? 300,
      recycleAfterMs: options.recycleAfterMs ?? readInt(env, 'RECYCLE_AFTER_MS') ?? 600_000,
      relaunchWaitMs: options.relaunchWaitMs ?? readInt(env, 'RELAUNCH_WAIT_MS') ?? 30_000,
    },
    render: {
      pageLoadTimeout: options.pageLoadTimeout ?? readInt(env, 'PAGE_LOAD_TIMEOUT') ?? 20_000,
      pageDoneCheckInterval:
        options.pageDoneCheckInterval ?? readInt(env, 'PAGE_DONE_CHECK_INTERVAL') ?? 500,
      waitAfterLastRequest:
        options.waitAfterLastRequest ?? readInt(env, 'WAIT_AFTER_LAST_REQUEST') ?? 500,
      renderReadyDelay: options.renderReadyDelay ?? readInt(env, 'RENDER_READY_DELAY') ?? 1_000,
      followRedirects: options.followRedirects ?? readBool(env, 'FOLLOW_REDIRECTS') ?? false,
      timeoutStatusCode: options.timeoutStatusCode ?? readInt(env, 'TIMEOUT_STATUS_CODE') ?? null,
      renderErrorStatusCode:
        options.renderErrorStatusCode ?? readInt(env, 'RENDER_ERROR_STATUS_CODE') ?? 504,
      userAgent: options.userAgent ?? readString(env, 'USER_AGENT') ?? null,
      viewportWidth: options.viewportWidth ?? readInt(env, 'VIEWPORT_WIDTH') ?? 1440,
      viewportHeight: options.viewportHeight ?? readInt(env, 'VIEWPORT_HEIGHT') ?? 718,
      originHeaders: options.originHeaders ?? { ...DEFAULT_ORIGIN_HEADERS },
      removeScriptTags: options.removeScriptTags ?? readBool(env, 'REMOVE_SCRIPT_TAGS') ?? true,
      absoluteUrls: options.absoluteUrls ?? readBool(env, 'ABSOLUTE_URLS') ?? true,
      metaStatusCode: options.metaStatusCode ?? readBool(env, 'META_STATUS_CODE') ?? true,
      injectRenderMeta: options.injectRenderMeta ?? readBool(env, 'INJECT_RENDER_META') ?? false,
      blockedResourceTypes:
        options.blockedResourceTypes ?? readList(env, 'BLOCKED_RESOURCE_TYPES') ?? [],
      blockedUrlPatterns: options.blockedUrlPatterns ?? readList(env, 'BLOCKED_URL_PATTERNS') ?? [],
    },
    access: {
      allowedDomains: options.allowedDomains ?? readList(env, 'ALLOWED_DOMAINS') ?? [],
      blockedDomains: options.blockedDomains ?? readList(env, 'BLOCKED_DOMAINS') ?? [],
      basicAuth,
    },
    logLevel: options.logLevel ?? readString(env, 'LOG_LEVEL') ?? 'info',
  };

  const result = configSchema.safeParse(candidate);
  if (!result.success) {
    throw new ConfigError(`Invalid renderready configuration:\n${z.prettifyError(result.error)}`);
  }

  const config = result.data;
  if (config.render.pageDoneCheckInterval > config.render.pageLoadTimeout) {
    throw new ConfigError(
      `pageDoneCheckInterval (${config.render.pageDoneCheckInterval}ms) must not exceed ` +
        `pageLoadTimeout (${config.render.pageLoadTimeout}ms), or a page can never be checked`,
    );
  }

  return config;
}
