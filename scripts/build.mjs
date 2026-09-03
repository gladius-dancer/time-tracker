import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the three Electron entry points with esbuild.
 *
 * Main and preload are bundled for Node/CommonJS with `electron` left external
 * (it is provided by the runtime). The renderer is bundled to a single classic
 * IIFE script because ES modules are blocked by CORS when a window is loaded
 * from file://.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: !dev,
  logLevel: 'info',
};

const withSmoke = watch || process.argv.includes('--smoke');

const targets = [
  {
    ...shared,
    entryPoints: [resolve(root, 'src/main/index.ts')],
    outfile: resolve(root, 'dist/main/index.js'),
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...shared,
    entryPoints: [resolve(root, 'src/preload/index.ts')],
    outfile: resolve(root, 'dist/preload/index.js'),
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...shared,
    entryPoints: [resolve(root, 'src/renderer/main.ts')],
    outfile: resolve(root, 'dist/renderer/renderer.js'),
    platform: 'browser',
    target: 'chrome120',
    format: 'iife',
  },
  ...(withSmoke
    ? [
        {
          // Node runner: `electron` is aliased to an in-memory stub so the
          // persistence and scheduling code can be tested without the runtime.
          ...shared,
          entryPoints: [resolve(root, 'tests/smoke.node.ts')],
          outfile: resolve(root, 'dist/smoke.node.js'),
          format: 'cjs',
          alias: { electron: resolve(root, 'tests/electron-stub.ts') },
        },
        {
          ...shared,
          entryPoints: [resolve(root, 'tests/smoke.electron.ts')],
          outfile: resolve(root, 'dist/smoke.electron.js'),
          format: 'cjs',
          external: ['electron'],
        },
      ]
    : []),
];

async function copyStatic() {
  await mkdir(resolve(root, 'dist/renderer'), { recursive: true });
  for (const file of ['index.html', 'styles.css']) {
    await cp(resolve(root, 'src/renderer', file), resolve(root, 'dist/renderer', file));
  }
}

await rm(resolve(root, 'dist'), { recursive: true, force: true });
await copyStatic();

if (watch) {
  const contexts = await Promise.all(targets.map((options) => context(options)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('[build] watching for changes…');
} else {
  await Promise.all(targets.map((options) => build(options)));
  console.log('[build] done');
}
