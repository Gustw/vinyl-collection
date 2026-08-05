/**
 * Copies the essentia.js WebAssembly runtime into src/assets.
 *
 * The audio analysis engine cannot simply be bundled. The single-file build
 * embeds Node's `fs`/`path` requires for its own non-browser code paths, which
 * esbuild refuses to resolve, so the browser build — glue script plus a
 * separate .wasm binary — is served as a static asset instead and loaded at
 * runtime from `assets/essentia/`.
 *
 * Copying rather than committing keeps a 2 MB binary out of the repository and
 * guarantees the .wasm always matches the version in package.json. It runs on
 * `postinstall` and again before every build and dev server, so a fresh clone
 * needs no extra step.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', 'node_modules', 'essentia.js', 'dist');
const to = join(here, '..', 'src', 'assets', 'essentia');

const FILES = ['essentia-wasm.web.js', 'essentia-wasm.web.wasm'];

if (!existsSync(from)) {
  console.error('essentia.js is not installed — run "npm install" first.');
  process.exit(1);
}

mkdirSync(to, { recursive: true });
for (const file of FILES) {
  copyFileSync(join(from, file), join(to, file));
}
console.log(`essentia runtime copied to src/assets/essentia (${FILES.join(', ')})`);

