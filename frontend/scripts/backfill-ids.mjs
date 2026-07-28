// Backfills "  ID: <releaseId>" lines into tracks.txt so every record carries a
// stable Discogs release id. Without ids the browser updater has to fall back to
// fragile name matching, which can fail and rebuild records from scratch
// (clearing their tracks). Sources, in priority order:
//   1) cache/discogs/<id>.json  (filename is the release id; has exact title)
//   2) collection.csv           (has Title, Artist, release_id columns)
//
// Usage: node scripts/backfill-ids.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..'); // C:\DEV\testing
const tracksPath = join(repo, 'tracks.txt');
const cacheDir = join(repo, 'cache', 'discogs');
const csvPath = join(repo, 'collection.csv');

const norm = (s) => (s || '').replace(/\uFEFF/g, '').trim().toLowerCase();
const stripNum = (s) => (s || '').replace(/\s*\(\d+\)$/, '').trim();
const nameKey = (title, artist) => `${norm(title)}\u0000${norm(artist)}`;

function joinArtists(artists) {
  if (!Array.isArray(artists) || !artists.length) return '';
  let out = '';
  for (const a of artists) {
    out += stripNum(String(a?.anv || '') || String(a?.name || ''));
    const j = String(a?.join || '').trim();
    if (j && j !== ',') out += ' ' + j + ' ';
    else if (j) out += j + ' ';
  }
  return out.trim();
}

// --- Build lookup maps -------------------------------------------------------
const byName = new Map(); // title\0artist -> id
const byTitle = new Map(); // title -> Set<id>
const addTitle = (title, id) => {
  const k = norm(title);
  if (!k) return;
  (byTitle.get(k) ?? byTitle.set(k, new Set()).get(k)).add(id);
};

// 1) cache jsons (most authoritative: filename IS the id)
let cacheCount = 0;
if (existsSync(cacheDir)) {
  for (const f of readdirSync(cacheDir)) {
    if (!f.endsWith('.json')) continue;
    const id = f.replace(/\.json$/, '');
    try {
      const j = JSON.parse(readFileSync(join(cacheDir, f), 'utf8'));
      const title = String(j?.title || '');
      const artist = joinArtists(j?.artists);
      if (title) {
        byName.set(nameKey(title, artist), id);
        addTitle(title, id);
        cacheCount++;
      }
    } catch {
      /* skip unreadable cache entry */
    }
  }
}

// 2) collection.csv (fills any gaps the cache misses)
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
let csvCount = 0;
if (existsSync(csvPath)) {
  const lines = readFileSync(csvPath, 'utf8').split(/\r?\n/);
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const ci = {
    artist: header.indexOf('artist'),
    title: header.indexOf('title'),
    id: header.indexOf('release_id'),
  };
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCsvLine(lines[i]);
    const id = (cols[ci.id] || '').trim();
    const title = cols[ci.title] || '';
    const artist = cols[ci.artist] || '';
    if (!id || !title) continue;
    const nk = nameKey(title, artist);
    if (!byName.has(nk)) byName.set(nk, id);
    addTitle(title, id);
    csvCount++;
  }
}

// --- Rewrite tracks.txt ------------------------------------------------------
const HEADER_RE = /^===\s(.*)\s===$/;
const text = readFileSync(tracksPath, 'utf8');
const lines = text.split(/\r?\n/);
const out = [];
let matched = 0;
let already = 0;
const unmatched = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  out.push(line);
  const h = HEADER_RE.exec(line.replace(/\uFEFF/g, '').trim());
  if (!h) continue;

  // Skip if the next non-empty line is already an ID line.
  const next = (lines[i + 1] || '').trim().toLowerCase();
  if (next.startsWith('id:')) { already++; continue; }

  const inner = h[1];
  const sep = inner.indexOf(' -- ');
  const title = sep >= 0 ? inner.slice(0, sep).trim() : inner.trim();
  const artist = sep >= 0 ? inner.slice(sep + 4).trim() : '';

  let id = byName.get(nameKey(title, artist));
  if (!id) {
    const set = byTitle.get(norm(title));
    if (set && set.size === 1) id = [...set][0]; // unique title match
  }
  if (id) {
    out.push(`  ID: ${id}`);
    matched++;
  } else {
    unmatched.push(`${title} -- ${artist}`);
  }
}

writeFileSync(tracksPath, out.join('\n'), 'utf8');

console.log(`Cache entries: ${cacheCount}, CSV rows: ${csvCount}`);
console.log(`Records: matched ${matched}, already had ID ${already}, unmatched ${unmatched.length}`);
if (unmatched.length) {
  console.log('Unmatched records (no ID inserted):');
  for (const u of unmatched) console.log('  - ' + u);
}

