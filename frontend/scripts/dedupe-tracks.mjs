// Deduplicate records in tracks.txt. Records are blocks starting with a
// "=== Title -- Artist ===" header. If the same header appears more than once
// (e.g. two updater runs wrote concurrently), keep the most complete copy:
// most track lines, then most lines containing a [Key: ...].
// Usage: npm run dedupe-data [-- <path-to-tracks.txt>]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] ?? resolve(here, '..', '..', 'tracks.txt');
const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/);

const HEADER = /^===\s.*\s===$/;
const blocks = [];
let cur = null;
for (const line of lines) {
  if (HEADER.test(line.trim())) {
    cur = { header: line.trim(), lines: [line] };
    blocks.push(cur);
  } else if (cur) {
    cur.lines.push(line);
  }
  // lines before the first header (if any) are dropped intentionally
}

const score = (b) => {
  const tracks = b.lines.filter((l) => /^\s*\d+\.\s+/.test(l)).length;
  const keys = b.lines.filter((l) => /\[Key:/.test(l)).length;
  return [tracks, keys];
};

const byKey = new Map();
const order = [];
for (const b of blocks) {
  const key = b.header.toLowerCase();
  const existing = byKey.get(key);
  if (!existing) {
    byKey.set(key, b);
    order.push(key);
    continue;
  }
  const [ec, ek] = score(existing);
  const [nc, nk] = score(b);
  if (nc > ec || (nc === ec && nk > ek)) byKey.set(key, b);
}

const out = order
  .map((k) => byKey.get(k).lines.join('\n').replace(/\s+$/, ''))
  .join('\n\n') + '\n';

writeFileSync(path, out, 'utf8');
console.log(`Deduped ${blocks.length} -> ${order.length} records in ${path}`);

