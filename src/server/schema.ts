/**
 * Request schema for `/render`, shared by the GET query string and the POST body.
 *
 * Fastify's Ajv instance coerces types, so `?width=800` arrives as the number
 * 800. `additionalProperties: false` is deliberate: silently ignoring a
 * misspelled option is worse than a 400 telling you about it.
 *
 * The `url` value itself is only checked for presence here — the real validation
 * (absolute, http/https, allowed domain) lives in `normalizeUrl` and
 * `assertDomainAllowed` so it is identical for programmatic callers.
 */
export const renderRequestSchema = {
  type: 'object',
  required: ['url'],
  additionalProperties: false,
  properties: {
    url: {
      type: 'string',
      minLength: 1,
      description: 'Absolute http(s) URL to render.',
    },
    width: {
      type: 'integer',
      minimum: 1,
      maximum: 10_000,
      description: 'Viewport width in CSS pixels.',
    },
    height: {
      type: 'integer',
      minimum: 1,
      maximum: 10_000,
      description: 'Viewport height in CSS pixels.',
    },
    userAgent: {
      type: 'string',
      minLength: 1,
      description: 'User-Agent to present to the origin.',
    },
    followRedirects: {
      type: 'boolean',
      description: 'Follow a redirect on the requested URL instead of returning the 3xx.',
    },
    timeout: {
      type: 'integer',
      minimum: 1,
      description: 'Render budget in milliseconds.',
    },
  },
} as const;

export interface RenderRequest {
  url: string;
  width?: number;
  height?: number;
  userAgent?: string;
  followRedirects?: boolean;
  timeout?: number;
}
