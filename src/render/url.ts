import type { AccessConfig } from '../config.js';
import { InvalidUrlError, UrlNotAllowedError } from '../errors.js';

/**
 * Validate and canonicalize a URL to render.
 *
 * Only http(s) is accepted: `file:`, `data:` and friends would let a caller read
 * from the machine the renderer runs on.
 *
 * @throws {InvalidUrlError} if absent, malformed, or not http(s).
 */
export function normalizeUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return failInvalid('A url is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return failInvalid(`Not a valid absolute URL: "${raw}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return failInvalid(`Only http and https URLs can be rendered, received "${parsed.protocol}"`);
  }

  if (parsed.hostname === '') {
    return failInvalid(`URL has no hostname: "${raw}"`);
  }

  return parsed.href;
}

function failInvalid(message: string): never {
  throw new InvalidUrlError(message);
}

/**
 * True when `hostname` is `domain` itself or a subdomain of it.
 *
 * Deliberately stricter than the prerender package, which used a bare substring
 * match — that made `ALLOWED_DOMAINS=example.com` also match
 * `example.com.attacker.test`.
 */
export function hostnameMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const candidate = domain.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  if (candidate === '') {
    return false;
  }
  return host === candidate || host.endsWith(`.${candidate}`);
}

/**
 * Enforce `allowedDomains` / `blockedDomains`. A non-empty allow list is
 * exclusive; the block list is checked first so it wins on overlap.
 *
 * @throws {UrlNotAllowedError} if the URL's host is excluded.
 */
export function assertDomainAllowed(url: string, access: AccessConfig): void {
  const { hostname } = new URL(url);

  if (access.blockedDomains.some(domain => hostnameMatches(hostname, domain))) {
    throw new UrlNotAllowedError(`Refusing to render blocked domain "${hostname}"`);
  }

  if (
    access.allowedDomains.length > 0 &&
    !access.allowedDomains.some(domain => hostnameMatches(hostname, domain))
  ) {
    throw new UrlNotAllowedError(`Refusing to render "${hostname}": not in the allowed domains`);
  }
}
