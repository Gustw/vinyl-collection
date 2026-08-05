/**
 * Key + BPM from Beatport.
 *
 * Beatport is the primary source because it publishes the *label's own*
 * metadata: the BPM and key come from the release itself rather than from an
 * audio analysis of whatever upload a service happened to index. For the
 * electronic 12"s this collection is made of that is both far more accurate and
 * far better at telling one mix of a record from another — Beatport keeps the
 * mix name (`mix_name`) as a separate field, which is exactly the distinction
 * the match checker in ./matching needs to reject a "Dub Mix" when the plain
 * cut was asked for. tunebat stays on as the backup for everything Beatport's
 * catalogue doesn't carry (older vinyl-only jungle, dubplates, reissues).
 *
 * Two ways in, tried in order:
 *
 *   1. the v4 API (`api.beatport.com/v4/catalog/search`), when a bearer token
 *      is configured — the documented, stable route;
 *   2. the public search page, whose Next.js `__NEXT_DATA__` blob carries the
 *      same track objects — no credentials needed, so the feature works out of
 *      the box for anyone who has only set up a CORS proxy.
 *
 * Neither host sends CORS headers, so both go through the configured proxy,
 * exactly like tunebat.
 */

import { AppConfig } from './config.service';
import { camelotToKeyName, keyNameToCamelot } from './camelot';
import { Candidate, MatchQuery, pickBestMatch } from './matching';
import {
  EMPTY,
  KeyInfo,
  LookupOptions,
  bpmText,
  keyTextOf,
  makeCache,
  normaliseKeyName,
  proxied,
  retryAfterMs,
  sleep,
} from './keyinfo';

const API_BASE = 'https://api.beatport.com/v4';
const WEB_SEARCH = 'https://www.beatport.com/search/tracks';

/** Cache namespace. v1: every entry here was written by the verified matcher. */
const cache = makeCache('beatport.v1.');

/** Returns a previously cached Beatport lookup for this artist/title, or null. */
export function cachedBeatportInfo(artist: string, title: string): KeyInfo | null {
  return cache.get(`${artist} ${title}`.trim());
}

// --- Reading Beatport's JSON --------------------------------------------

function textOf(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Artist names, from either spelling.
 *
 * The catalog endpoint credits artists as `[{id, name}]`; the search index uses
 * `[{artist_id, artist_name}]`. Bare strings are accepted too.
 */
function namesOf(v: unknown): string[] {
  if (!Array.isArray(v)) {
    const one = textOf(v);
    return one ? [one] : [];
  }
  return v
    .map((x) =>
      typeof x === 'string'
        ? x.trim()
        : textOf((x as any)?.name) || textOf((x as any)?.artist_name)
    )
    .filter(Boolean);
}

/** The track's title, from either spelling. */
function titleOf(o: any): string {
  return textOf(o?.name) || textOf(o?.track_name);
}

/**
 * Whether an object looks like a track record.
 *
 * Beatport exposes tracks in two quite different shapes and this has to accept
 * both: the documented catalog object (`name`, `artists[].name`, a nested `key`
 * with a camelot code) and the search index one the site itself is served from
 * (`track_name`, `artists[].artist_name`, a flat `key_name` string and no
 * camelot anywhere). Rather than committing to a response path — which is what
 * broke the first version of this file — tracks are recognised by their shape
 * wherever they turn up. A `release` also carries a name and an artist list, so
 * a tempo/key field is required to tell the two apart.
 */
function looksLikeTrack(o: any): boolean {
  if (!o || typeof o !== 'object') return false;
  if (!titleOf(o)) return false;
  if (!Array.isArray(o.artists)) return false;
  return (
    o.bpm != null ||
    o.key != null ||
    o.key_name != null ||
    typeof o.mix_name === 'string'
  );
}

const MAX_CANDIDATES = 200;

/** Collects every track-shaped object anywhere in a response. */
function collectTracks(root: any): any[] {
  const out: any[] = [];
  const seen = new Set<any>();
  const walk = (node: any, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 14) return;
    if (out.length >= MAX_CANDIDATES) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1);
      return;
    }
    if (looksLikeTrack(node)) out.push(node);
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(root, 0);
  return out;
}

/**
 * The identity of a track, in the form the match checker expects.
 *
 * Beatport splits the title from the mix ("Greece 2000" + "Max Styler Extended
 * Rework"), so the two are re-joined with the mix in brackets — the notation
 * ./matching parses to decide whether both sides mean the same recording.
 * Remixers join the artist list: the matcher scores by containment, so naming
 * more people can only help a query that credits the remixer, and never hurts
 * one that doesn't.
 */
function identityOf(item: any): Candidate {
  const base = titleOf(item);
  const mix = textOf(item?.mix_name);
  const name = base && mix ? `${base} (${mix})` : base;
  return { name, artists: [...namesOf(item?.artists), ...namesOf(item?.remixers)] };
}

/** "8A" from whichever of Beatport's key shapes is present, else ''. */
function camelotOf(item: any): string {
  const k = item?.key;
  const direct = textOf(k?.camelot).toUpperCase();
  if (/^\d{1,2}[AB]$/.test(direct)) return direct;
  const n = Number(k?.camelot_number);
  const letter = textOf(k?.camelot_letter).toUpperCase();
  if (Number.isInteger(n) && n >= 1 && n <= 12 && (letter === 'A' || letter === 'B')) {
    return `${n}${letter}`;
  }
  // The search index publishes no wheel position at all, so derive it.
  return keyNameToCamelot(keyNameOf(item));
}

/**
 * The key's name, from any of the three spellings: a flat `key_name` string
 * (search index), a nested `key.name`, or the letter/accidental/chord-type
 * triple the catalog endpoint sometimes uses.
 */
function keyNameOf(item: any): string {
  const flat = textOf(item?.key_name);
  if (flat) return flat;
  const k = item?.key;
  const name = textOf(k?.name);
  if (name) return name;
  const letter = textOf(k?.letter);
  if (!letter) return '';
  const accidental = k?.is_sharp ? '#' : k?.is_flat ? 'b' : '';
  const chord = textOf(k?.chord_type?.name) || textOf(k?.chord_type);
  return `${letter}${accidental} ${chord}`.trim();
}

/**
 * Genres whose records Beatport frequently lists at half their playing tempo.
 *
 * This is a real and inconsistent quirk of its catalogue, not a matching
 * artefact: a search for jungle returns "Jungle Souljah" at 83 and "Original
 * Nuttah 25" at 91 alongside other drum & bass at 155 and 170. Both readings
 * describe the same records — 83 is simply the half-time count — but a vinyl
 * DJ beatmatches at the played tempo, and a jungle 12" filed at 83 BPM will
 * never appear mixable with the rest of the box.
 */
const HALF_TIME_GENRES = /drum\s*&?\s*n?\s*bass|jungle|breakcore/i;

/** Lowest tempo any record in those genres is actually played at. */
const HALF_TIME_FLOOR = 110;

/** Every genre/sub-genre label on a track, in either spelling. */
function genresOf(item: any): string {
  const list = Array.isArray(item?.genre) ? item.genre : item?.genre ? [item.genre] : [];
  const sub = item?.sub_genre ? [item.sub_genre] : [];
  return [...list, ...sub]
    .map((g: any) =>
      typeof g === 'string' ? g : textOf(g?.genre_name) || textOf(g?.sub_genre_name) || textOf(g?.name)
    )
    .filter(Boolean)
    .join(' ');
}

/**
 * Beatport's tempo, converted to the one the record is actually played at.
 *
 * Only doubles a reading that is impossibly slow *for its own stated genre* —
 * no drum & bass or jungle record plays at 83 BPM — so this corrects a known
 * notation convention rather than guessing at data. Anything at or above the
 * floor, and every other genre, is passed through untouched.
 */
function playedTempo(item: any): string {
  const raw = bpmText(item?.bpm);
  if (!raw) return '';
  const n = Number(raw);
  if (n >= HALF_TIME_FLOOR) return raw;
  return HALF_TIME_GENRES.test(genresOf(item)) ? String(n * 2) : raw;
}

/** Pulls key/BPM out of one Beatport track object. */
function keyInfoOf(item: any): KeyInfo {
  const bpm = playedTempo(item);
  const camelot = camelotOf(item);
  // Prefer Beatport's own spelling; fall back to the canonical name for the
  // Camelot code when the key object only carried the wheel position.
  const keyName = normaliseKeyName(keyNameOf(item)) || camelotToKeyName(camelot);
  return { keyName, camelot, keyText: keyTextOf(keyName, camelot), bpm, source: 'beatport' };
}

// --- Talking to Beatport -------------------------------------------------

/**
 * Fetches a URL, waiting out any 429 the way the tunebat client does. Returns
 * null when the request failed, was blocked (CORS without a proxy) or the job
 * was cancelled mid-backoff.
 */
async function fetchWithBackoff(
  target: string,
  opts: LookupOptions,
  headers: Record<string, string>
): Promise<Response | null> {
  const { onStatus, isCancelled, onRateLimitWait } = opts;
  const MAX_RATE_WAITS = 5;
  let rateWaits = 0;
  while (true) {
    if (isCancelled?.()) return null;
    let res: Response;
    try {
      res = await fetch(target, { headers });
    } catch {
      return null; // network/CORS failure
    }
    if (res.status !== 429) return res;

    if (rateWaits++ >= MAX_RATE_WAITS) return null;
    const wait = retryAfterMs(res) ?? 30000;
    onStatus?.(
      `Rate limited by Beatport — waiting ${Math.round(wait / 1000)}s ` +
        `(${rateWaits}/${MAX_RATE_WAITS})…`
    );
    // Sleep in slices so a cancellation isn't stuck behind a long backoff.
    let waited = 0;
    for (let left = wait; left > 0; left -= 250) {
      if (isCancelled?.()) {
        onRateLimitWait?.(waited);
        return null;
      }
      const slice = Math.min(250, left);
      await sleep(slice);
      waited += slice;
    }
    onRateLimitWait?.(waited);
  }
}

/** Bearer header for the configured token, or nothing when none is set. */
function authHeaders(cfg: AppConfig): Record<string, string> {
  const token = (cfg.beatportToken || '').trim();
  if (!token) return {};
  const value = /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
  return { Authorization: value };
}

/**
 * Set once the API has answered 401/403, so a stale or absent token costs one
 * wasted request per session rather than one per track.
 */
let apiRejected = false;

/** Searches the v4 API. Returns [] when unauthenticated or unreachable. */
async function searchApi(cfg: AppConfig, term: string, opts: LookupOptions): Promise<any[]> {
  if (apiRejected) return [];
  const auth = authHeaders(cfg);
  if (!auth['Authorization']) return []; // the API rejects anonymous callers
  const url =
    `${API_BASE}/catalog/search/?type=tracks&per_page=25&q=` + encodeURIComponent(term);
  const res = await fetchWithBackoff(proxied(url, cfg), opts, {
    Accept: 'application/json',
    ...auth,
  });
  if (!res) return [];
  if (res.status === 401 || res.status === 403) {
    apiRejected = true;
    opts.onStatus?.(
      'Beatport rejected the API token — falling back to the public search page. ' +
        'Check the token in settings (and that your CORS proxy forwards the ' +
        'Authorization header).'
    );
    return [];
  }
  if (res.status !== 200) return [];
  try {
    return collectTracks(await res.json());
  } catch {
    return [];
  }
}

/** Pulls the Next.js SSR payload out of a Beatport page. */
function nextData(html: string): any | null {
  const m = /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Searches the public web UI and reads the tracks out of its SSR state. This is
 * the no-credentials path: Beatport renders the results server-side, so the
 * full track objects (bpm, key, mix_name) are in the HTML.
 */
async function searchWeb(cfg: AppConfig, term: string, opts: LookupOptions): Promise<any[]> {
  const url = `${WEB_SEARCH}?q=` + encodeURIComponent(term);
  const res = await fetchWithBackoff(proxied(url, cfg), opts, { Accept: 'text/html' });
  if (!res || res.status !== 200) return [];
  let html: string;
  try {
    html = await res.text();
  } catch {
    return [];
  }
  const data = nextData(html);
  return data ? collectTracks(data) : [];
}

/**
 * Fetches one track by id. Some search shapes return only a relevance stub
 * (score + ids, no tempo), in which case the winner is re-read in full rather
 * than reported as "no key found".
 */
async function fetchTrack(
  cfg: AppConfig,
  id: number,
  opts: LookupOptions
): Promise<any | null> {
  if (apiRejected) return null;
  const auth = authHeaders(cfg);
  if (!auth['Authorization']) return null;
  const url = `${API_BASE}/catalog/tracks/${id}/`;
  const res = await fetchWithBackoff(proxied(url, cfg), opts, {
    Accept: 'application/json',
    ...auth,
  });
  if (!res || res.status !== 200) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// --- The lookup ----------------------------------------------------------

/**
 * Looks up a track's key + BPM on Beatport.
 *
 * Behaves exactly like the tunebat client so the two are interchangeable:
 * answers are cached in localStorage (under their own namespace, so the two
 * sources can never be confused), a forced lookup ignores the cache, and a
 * failed or blocked request returns empty rather than erasing what is known.
 *
 * Every hit is scored against the artist, title *and* mix asked for before it
 * is accepted (see ./matching). Nothing convincing means nothing is returned:
 * a missing BPM merely drops the track out of the mixable list, while a wrong
 * one quietly falsifies every transition and bridge computed from it.
 */
export async function lookupKeyBeatport(
  cfg: AppConfig,
  artist: string,
  title: string,
  opts: LookupOptions = {}
): Promise<KeyInfo> {
  const { onStatus, force = false, isCancelled } = opts;
  const term = `${artist} ${title}`.trim();
  const query: MatchQuery = { artist, title };

  const cached = cache.get(term);
  if (!force && cached && cached.bpm) return cached; // fully cached
  // A forced re-fetch must not fall back to the (possibly wrong) cached value.
  const fallback = force ? { ...EMPTY } : cached ?? { ...EMPTY };
  const keep = () => (fallback.keyName ? { ...fallback, bpm: '' } : { ...EMPTY });

  if (isCancelled?.()) return keep();

  // The API first when it can be used (documented and stable), otherwise the
  // public page — which needs no credentials and carries the same objects.
  let items = await searchApi(cfg, term, opts);
  if (!items.length) items = await searchWeb(cfg, term, opts);
  if (!items.length) return keep();

  const best = pickBestMatch(query, items, identityOf);
  if (!best.item || !best.candidate) {
    onStatus?.(`No confident Beatport match for ${artist} - ${title}`);
    return keep();
  }

  let info = keyInfoOf(best.item);
  if (!info.bpm && !info.keyName) {
    // The catalog spells the id `id`, the search index `track_id`.
    const id = Number((best.item as any)?.id ?? (best.item as any)?.track_id);
    if (Number.isInteger(id) && id > 0) {
      const full = await fetchTrack(cfg, id, opts);
      if (full) info = keyInfoOf(full);
    }
  }
  if (!info.bpm && !info.keyName) return keep();

  const who = best.candidate.artists.join(', ');
  const merged: KeyInfo = {
    keyName: info.keyName || fallback.keyName,
    camelot: info.camelot || fallback.camelot,
    keyText: info.keyText || fallback.keyText,
    bpm: info.bpm || fallback.bpm,
    matched: who ? `${best.candidate.name} - ${who}` : best.candidate.name,
    confidence: best.score ? Number(best.score.score.toFixed(3)) : undefined,
    source: 'beatport',
  };
  cache.set(term, merged);
  return merged;
}

