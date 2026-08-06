import type { BrowserConfig } from '../config.js';

/**
 * Flags every launch gets.
 *
 * `--no-sandbox` is required to run Chromium inside most containers, which is
 * how a prerender server is nearly always deployed. It is safe here only because
 * the pages being loaded are ones you chose to render — see the security note in
 * the README, and prefer `allowedDomains` if the URL is caller-controlled.
 */
const BASE_ARGS = [
  '--no-sandbox',
  '--disable-software-rasterizer',
  // /dev/shm is tiny in the default Docker configuration; without this Chromium
  // runs out of shared memory and crashes under load.
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-extensions',
  '--disable-translate',
  '--disable-sync',
  '--disable-logging',
  '--mute-audio',
  '--disable-gpu',
  '--hide-scrollbars',
] as const;

/**
 * Build the Chromium argument list.
 *
 * Images and fonts are disabled at the engine level rather than through request
 * interception. Two reasons: the rendered output has its `<script>` tags stripped
 * and `<img>` elements are serialized regardless of whether their bytes ever
 * arrived, so image data cannot affect the HTML we return; and routing every
 * request through Node to abort it costs more than letting Blink skip the work.
 * Image decode is among the most CPU-expensive parts of rendering, so this is a
 * large saving for output that is identical either way.
 */
export function buildChromeArgs(config: BrowserConfig): string[] {
  const args: string[] = [...BASE_ARGS];

  if (config.blockImages) {
    args.push('--blink-settings=imagesEnabled=false');
  }
  if (config.blockFonts) {
    args.push('--disable-remote-fonts');
  }

  return [...args, ...config.extraChromeArgs];
}

/**
 * Make a headless user-agent look like ordinary Chrome.
 *
 * Chromium reports `HeadlessChrome/1.2.3`, which a fair number of sites treat as
 * a bot and serve degraded content to — the opposite of what a prerenderer wants.
 */
export function stripHeadlessMarker(userAgent: string): string {
  return userAgent.replace(/HeadlessChrome/g, 'Chrome');
}
