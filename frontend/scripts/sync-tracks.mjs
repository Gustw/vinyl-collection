// Copies the repo-root tracks.txt into the app's assets, where it is bundled as
// the offline fallback for when the GitHub raw URL isn't reachable.
// Usage: npm run sync-data
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', '..', 'tracks.txt');
const dest = resolve(here, '..', 'src', 'assets', 'tracks.txt');

if (!existsSync(src)) {
  console.error('Source not found: ' + src);
  process.exit(1);
}
copyFileSync(src, dest);
console.log('Copied ' + src + ' -> ' + dest);

