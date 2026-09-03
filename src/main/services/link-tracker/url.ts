/** URL helpers shared by every link source. */

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/i;

/**
 * Returns a canonical http(s) URL, or null when the input is not one.
 * Canonicalising here means dedupe works across sources that report the same
 * page with different trailing slashes or fragments.
 */
export function normaliseUrl(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : (trimmed.match(URL_PATTERN)?.[0] ?? null);
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
