/** URL helpers shared by every link source. */

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/i;

/**
 * A bare `host[:port][/path]` with a plausible TLD, and nothing that looks like a
 * Windows path, a search phrase or a local file.
 *
 * Browser address bars routinely hide the scheme -- Chrome and Edge show
 * `github.com/user/repo`, and often just `github.com` when unfocused. Requiring
 * `https://` there means never recording anything at all.
 */
const SCHEMELESS_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(?::\d{1,5})?(?:[/?#].*)?$/i;

export interface NormaliseOptions {
  /**
   * Accept `example.com/path` as `https://example.com/path`.
   *
   * Enabled for address-bar sources, where the scheme is cosmetically hidden.
   * Left off for the clipboard, where treating every copied `notes.txt`-ish
   * string as a visited link would be noise.
   */
  allowSchemeless?: boolean;
}

/**
 * Returns a canonical http(s) URL, or null when the input is not one.
 * Canonicalising here means dedupe works across sources that report the same
 * page with different trailing slashes or fragments.
 */
export function normaliseUrl(input: string, options: NormaliseOptions = {}): string | null {
  if (!input) return null;
  const trimmed = input.trim();

  let candidate: string | null;
  if (/^https?:\/\//i.test(trimmed)) {
    // The whole input is a URL, so only whitespace can terminate it. Splitting on
    // whitespace (rather than applying URL_PATTERN) keeps brackets that are part
    // of the address -- `…/Foo_(bar)` -- while still discarding trailing text such
    // as the " - Mozilla Firefox" a window title appends.
    candidate = trimmed.split(/\s/)[0] ?? null;
  } else {
    // Embedded in prose: stop at the punctuation that usually closes a citation.
    candidate = trimmed.match(URL_PATTERN)?.[0] ?? null;
  }

  if (!candidate && options.allowSchemeless) {
    // Reject anything with whitespace or a backslash first: those are search
    // queries and Windows paths (`C:\Users\…`), never address-bar URLs.
    if (!/[\s\\]/.test(trimmed) && SCHEMELESS_PATTERN.test(trimmed)) {
      candidate = `https://${trimmed}`;
    }
  }
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Pages that are noise rather than "a link the user opened". */
export function isIgnorable(url: string): boolean {
  const host = hostOf(url);
  if (!host) return true;
  return host === 'localhost' || host === 'newtab' || host.endsWith('.invalid');
}
