// Copies the latest tracks.txt export from the Java tool into the app's assets.
// Usage: npm run sync-data
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', '..', 'tracks.txt'); // C:\DEV\testing\tracks.txt
const dest = resolve(here, '..', 'src', 'assets', 'tracks.txt');

if (!existsSync(src)) {
  console.error('Source not found: ' + src);
  process.exit(1);
}
copyFileSync(src, dest);
console.log('Copied ' + src + ' -> ' + dest);

