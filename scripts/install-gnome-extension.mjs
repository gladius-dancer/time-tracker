/**
 * Installs the GNOME Shell extension that lets Time Tracker see the focused
 * window on Wayland.
 *
 * It is a separate, opt-in step rather than part of `npm install` because it
 * writes into the user's GNOME configuration and needs them to log out before
 * the shell will load it -- Wayland has no way to reload an extension in place.
 *
 *   npm run install:gnome-extension
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'resources', 'linux', 'gnome-extension');

if (process.platform !== 'linux') {
  console.error('This extension is only useful on a Linux desktop running GNOME.');
  process.exit(1);
}

const { uuid, name } = JSON.parse(await readFile(join(source, 'metadata.json'), 'utf8'));
const target = join(homedir(), '.local', 'share', 'gnome-shell', 'extensions', uuid);

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log(`Installed ${name} to ${target}`);

try {
  execFileSync('gnome-extensions', ['enable', uuid], { stdio: 'pipe' });
  console.log(`Enabled ${uuid}`);
} catch {
  // `gnome-extensions enable` asks the *running* shell, which has not scanned the
  // new directory yet and answers "doesn't exist". The setting it would write is
  // just a GSettings list, and writing it directly works before the shell has
  // ever heard of the extension -- so the user gets one step instead of two.
  enableViaGSettings(uuid);
}

function enableViaGSettings(id) {
  const read = (key) =>
    execFileSync('gsettings', ['get', 'org.gnome.shell', key], { encoding: 'utf8' }).trim();
  try {
    const current = read('enabled-extensions');
    // GVariant array syntax: `@as []` when empty, otherwise `['a', 'b']`.
    const existing = current.startsWith('@as')
      ? []
      : [...current.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    if (existing.includes(id)) {
      console.log(`Already enabled: ${id}`);
      return;
    }
    // Appended, never replaced: this list may already carry the user's own
    // extensions, and overwriting it would silently switch them all off.
    const next = `[${[...existing, id].map((e) => `'${e}'`).join(', ')}]`;
    execFileSync('gsettings', ['set', 'org.gnome.shell', 'enabled-extensions', next]);
    console.log(`Enabled ${id}`);

    if (read('disable-user-extensions') === 'true') {
      console.log(
        '\nNote: user extensions are switched off session-wide. Turn them back on with:\n' +
          '  gsettings set org.gnome.shell disable-user-extensions false',
      );
    }
  } catch (error) {
    console.log(`Could not enable it automatically — after logging back in, run:\n  gnome-extensions enable ${id}`);
  }
}

console.log(
  '\nLog out and back in to finish.\n' +
    'GNOME cannot load a newly installed extension into a running Wayland session,\n' +
    'so Applications Used stays unavailable until you do.\n\n' +
    'To verify afterwards:\n' +
    `  gnome-extensions info ${uuid}\n` +
    '  gdbus call --session --dest org.timetracker.WindowInfo \\\n' +
    '    --object-path /org/timetracker/WindowInfo \\\n' +
    '    --method org.timetracker.WindowInfo.GetFocusedWindow',
);
