/**
 * Checks for the Windows address-bar link source.
 *
 * The detector's PowerShell half can only run on Windows, so the OS boundary is
 * drawn at its output: the script speaks a small line protocol, and everything
 * that decides whether a link gets recorded lives in `parseAddressBarOutput`,
 * which is pure and runs anywhere. The fixtures below are the shapes a real
 * Windows run produces -- above all the scheme-less omnibox value that Chrome and
 * Edge emit, which the previous strict parser discarded, recording nothing.
 */
import {
  parseAddressBarOutput,
  type AddressBarScan,
} from '../src/main/services/link-tracker/sources/windows';
import { normaliseUrl } from '../src/main/services/link-tracker/url';

type Check = (label: string, ok: boolean, detail?: string) => void;

const TAB = '\t';
const line = (...parts: string[]): string => parts.join(TAB);

function urls(scan: AddressBarScan): string[] {
  return scan.links.map((l) => l.url);
}

export function runWindowsLinkChecks(check: Check): void {
  // -- the bug that made Windows detect nothing ----------------------------
  const chrome = parseAddressBarOutput(
    line('##URL', 'github.com/anthropics/claude-code', 'claude-code - Google Chrome'),
  );
  check(
    'a scheme-less Chrome omnibox value becomes a URL',
    urls(chrome)[0] === 'https://github.com/anthropics/claude-code',
    urls(chrome)[0] ?? 'nothing recorded',
  );
  check('its window title is kept', chrome.links[0]?.title === 'claude-code - Google Chrome');
  check('it is attributed to the browser window', chrome.links[0]?.source === 'browser-window');

  const bare = parseAddressBarOutput(line('##URL', 'github.com', 'GitHub'));
  check('a bare domain becomes a URL', urls(bare)[0] === 'https://github.com/', urls(bare)[0] ?? 'nothing');

  const withPort = parseAddressBarOutput(line('##URL', 'example.com:8443/app', 'App'));
  check('a host with a port is accepted', urls(withPort)[0] === 'https://example.com:8443/app');

  const explicit = parseAddressBarOutput(line('##URL', 'https://example.com/a?b=1#frag', 'Example'));
  check(
    'an explicit URL still works and drops the fragment',
    urls(explicit)[0] === 'https://example.com/a?b=1',
    urls(explicit)[0] ?? 'nothing',
  );

  const insecure = parseAddressBarOutput(line('##URL', 'http://intranet.local/page', 'Intranet'));
  check('http is preserved rather than upgraded', urls(insecure)[0] === 'http://intranet.local/page');

  // -- things that must NOT be recorded ------------------------------------
  const query = parseAddressBarOutput(line('##URL', 'how to fix windows permissions', 'Search'));
  check('a typed search phrase is not a link', query.links.length === 0);

  const winPath = parseAddressBarOutput(line('##URL', 'C:\\Users\\me\\notes.txt', 'Notes'));
  check('a Windows file path is not a link', winPath.links.length === 0, urls(winPath).join(','));

  const empty = parseAddressBarOutput(line('##URL', '', 'Blank'));
  check('an empty address bar is ignored', empty.links.length === 0);

  const filename = parseAddressBarOutput(line('##URL', 'report .docx', 'Doc'));
  check('a value containing a space is rejected', filename.links.length === 0);

  // -- protocol handling ---------------------------------------------------
  const none = parseAddressBarOutput('##NOBROWSERS');
  check('no browsers open reports no browsers and no error', !none.browsersSeen && none.error === null);

  const failed = parseAddressBarOutput(line('##ERR', 'UI Automation assemblies unavailable: boom'));
  check('a script failure is reported as an error', failed.error?.includes('boom') === true, failed.error ?? '');
  check('a script failure records no links', failed.links.length === 0);

  const perWindow = parseAddressBarOutput(line('##WINERR', 'chrome', 'element not available'));
  check('a per-window failure is a warning, not fatal', perWindow.error === null && perWindow.warnings.length === 1);
  check('a per-window failure still counts as a browser seen', perWindow.browsersSeen);

  const noUrl = parseAddressBarOutput(line('##NOURL', 'Some Page - Mozilla Firefox'));
  check('an unreadable address bar yields no link', noUrl.links.length === 0 && noUrl.browsersSeen);

  const titleUrl = parseAddressBarOutput(line('##NOURL', 'https://example.org/x - Mozilla Firefox'));
  check(
    'a URL sitting in the window title is salvaged',
    urls(titleUrl)[0] === 'https://example.org/x',
    urls(titleUrl)[0] ?? 'nothing',
  );

  const parens = parseAddressBarOutput(
    line('##URL', 'https://en.wikipedia.org/wiki/Foo_(bar)', 'Foo (bar) - Wikipedia'),
  );
  check(
    'brackets inside an address are preserved',
    urls(parens)[0] === 'https://en.wikipedia.org/wiki/Foo_(bar)',
    urls(parens)[0] ?? 'nothing',
  );

  // -- resilience ----------------------------------------------------------
  const multi = parseAddressBarOutput(
    [
      'WARNING: something noisy from the host',
      line('##URL', 'github.com/a', 'A - Chrome'),
      line('##NOURL', 'Untitled - Edge'),
      line('##URL', 'https://news.example.com/story', 'Story - Edge'),
      '',
    ].join('\r\n'),
  );
  check('stray output is tolerated', multi.error === null);
  check('CRLF output parses', multi.links.length === 2, `${multi.links.length} link(s)`);
  check(
    'multiple windows are all reported',
    urls(multi).join(' | ') === 'https://github.com/a | https://news.example.com/story',
    urls(multi).join(' | '),
  );

  const blank = parseAddressBarOutput('');
  check('empty output is harmless', blank.links.length === 0 && blank.error === null && !blank.browsersSeen);

  // -- the clipboard must stay strict --------------------------------------
  check("clipboard text 'github.com' is still not treated as a link", normaliseUrl('github.com') === null);
  check(
    'clipboard text with an explicit scheme still is',
    normaliseUrl('see https://example.com/x here') === 'https://example.com/x',
  );
}
