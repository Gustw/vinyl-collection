import { AppConfig } from './config.service';
import { keyNameToCamelot } from './camelot';
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

export type { KeyInfo, LookupOptions } from './keyinfo';

/**
 * Cache namespace. Bumped to v2 when match verification was added: entries
 * written by the old "trust the first hit" code cannot be told apart from
 * verified ones, and measurably ~40% of them were wrong, so they are abandoned
 * rather than trusted. Old `tunebat.*` keys are simply never read again.
 */
const CACHE_PREFIX = 'tunebat.v2.';

const cache = makeCache(CACHE_PREFIX);

/**
 * Returns a previously cached lookup for this artist/title, or null. Used to
 * rehydrate the collection after a page reload so progress isn't lost when it
 * hasn't been committed to GitHub yet.
 */
export function cachedKeyInfo(artist: string, title: string): KeyInfo | null {
  return cache.get(`${artist} ${title}`.trim());
}

function textOf(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function namesOf(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean);
  }
  const one = textOf(v);
  return one ? [one] : [];
}

/**
 * Reads a search hit's identity. tunebat abbreviates its fields (`n` for name,
 * `as` for artists, alongside the `k`/`c`/`b` this file already relies on);
 * the alternatives are accepted defensively so a schema change degrades
 * gracefully instead of rejecting every result.
 */
function identityOf(item: any): Candidate {
  const name =
    textOf(item?.n) || textOf(item?.name) || textOf(item?.title) || textOf(item?.trackName);
  let artists = namesOf(item?.as);
  if (!artists.length) artists = namesOf(item?.artists);
  if (!artists.length) artists = namesOf(item?.artistName);
  if (!artists.length) artists = namesOf(item?.ar);
  return { name, artists };
}

/** Pulls key/BPM out of one search hit. */
function keyInfoOf(item: any): KeyInfo {
  const bpm = bpmText(item?.b);
  // Normalise ♭/♯ to ASCII so it matches the rest of the pipeline.
  const key = normaliseKeyName(String(item?.k || '').trim());
  // Fall back to deriving the wheel position from the key name: without a
  // Camelot code a track is silently absent from every key filter and mixable
  // list, so a missing `c` must not cost us the key entirely.
  const camelot = String(item?.c || '').trim() || keyNameToCamelot(key);
  if (!key) return { keyName: '', camelot, keyText: '', bpm, source: 'tunebat' };
  return { keyName: key, camelot, keyText: keyTextOf(key, camelot), bpm, source: 'tunebat' };
}

/** Warned once per session — a schema surprise is worth noticing, not spamming. */
let warnedNoIdentity = false;

/**
 * Chooses the right hit from a search response, or none.
 *
 * Falls back to the old "first hit" behaviour only when *no* result exposes a
 * readable title: that means the response schema is not what is expected, and
 * silently returning nothing for every track would be a worse failure than the
 * one being fixed. Such answers are flagged unverified rather than cached as
 * confident.
 */
function selectMatch(json: any, query: MatchQuery): KeyInfo {
  const items = json?.data?.items;
  if (!Array.isArray(items) || !items.length) return { ...EMPTY };

  const readable = items.some((it: any) => !!identityOf(it).name);
  if (!readable) {
    if (!warnedNoIdentity) {
      warnedNoIdentity = true;
      console.warn(
        'tunebat: no readable track titles in the search response — falling back ' +
          'to the first hit unverified. Check the API response shape.'
      );
    }
    return { ...keyInfoOf(items[0]), matched: '', confidence: undefined };
  }

  const best = pickBestMatch(query, items as any[], identityOf);
  if (!best.item || !best.candidate) return { ...EMPTY };

  const who = best.candidate.artists.join(', ');
  return {
    ...keyInfoOf(best.item),
    matched: who ? `${best.candidate.name} - ${who}` : best.candidate.name,
    confidence: best.score ? Number(best.score.score.toFixed(3)) : undefined,
  };
}


/**
 * Looks up a track's key + BPM on tunebat. Results (including "not found",
 * only when it actually reached the API) are cached in localStorage so
 * re-runs skip them. Returns empty fields when nothing is found or the
 * request is blocked (e.g. CORS without a proxy).
 *
 * Every hit is checked against the artist, title and version asked for before
 * it is accepted (see ./matching). When nothing in the response is convincingly
 * the right track this returns empty rather than the closest thing tunebat had
 * — a missing key only drops the track out of the mixable list, whereas a wrong
 * one silently corrupts every transition and bridge computed from it.
 *
 * On HTTP 429 it backs off (honouring Retry-After, else 60s) and retries the
 * same term instead of hammering the API, reporting the wait via onStatus and
 * its length via onRateLimitWait.
 */
export async function lookupKey(
  cfg: AppConfig,
  artist: string,
  title: string,
  opts: LookupOptions = {}
): Promise<KeyInfo> {
  const { onStatus, force = false, isCancelled, onRateLimitWait } = opts;
  const term = `${artist} ${title}`.trim();
  const query: MatchQuery = { artist, title };
  const cached = cache.get(term);
  if (!force && cached && cached.bpm) return cached; // fully cached
  // A forced re-fetch must not fall back to the (possibly wrong) cached value.
  const fallback = force ? { ...EMPTY } : cached ?? { ...EMPTY };
  const keep = () => (fallback.keyName ? { ...fallback, bpm: '' } : { ...EMPTY });

  // The version stays in the query: it is what lets the right pressing rank at
  // all when tunebat has it. Anything it drags in is filtered out by the match
  // check, which scans the whole result list rather than just the top hit.
  const url =
    'https://api.tunebat.com/api/tracks/search?term=' + encodeURIComponent(term);
  const target = proxied(url, cfg);

  const MAX_RATE_WAITS = 5;
  let rateWaits = 0;
  while (true) {
    if (isCancelled?.()) return keep();
    let res: Response;
    try {
      res = await fetch(target, { headers: { Accept: 'application/json' } });
    } catch {
      // Network/CORS failure: keep whatever we knew (retried next run).
      return keep();
    }

    if (res.status === 429) {
      if (rateWaits++ >= MAX_RATE_WAITS) return keep();
      const wait = retryAfterMs(res) ?? 60000; // default 60s like the Java tool
      onStatus?.(
        `Rate limited by tunebat — waiting ${Math.round(wait / 1000)}s ` +
          `(${rateWaits}/${MAX_RATE_WAITS})…`
      );
      // Sleep in slices so a cancellation isn't stuck behind a long backoff.
      let waited = 0;
      for (let left = wait; left > 0; left -= 250) {
        if (isCancelled?.()) {
          onRateLimitWait?.(waited);
          return keep();
        }
        const slice = Math.min(250, left);
        await sleep(slice);
        waited += slice;
      }
      onRateLimitWait?.(waited);
      continue; // retry the same term
    }

    if (res.status !== 200) return keep();

    let json: any;
    try {
      json = await res.json();
    } catch {
      return keep();
    }
    const info = selectMatch(json, query);
    // Merge onto anything we already had so we never drop a known field, and
    // cache whenever we learned a key OR a BPM so a page reload can restore it.
    if (info.keyName || info.bpm) {
      const merged: KeyInfo = {
        keyName: info.keyName || fallback.keyName,
        camelot: info.camelot || fallback.camelot,
        keyText: info.keyText || fallback.keyText,
        bpm: info.bpm || fallback.bpm,
        matched: info.matched || fallback.matched,
        confidence: info.confidence ?? fallback.confidence,
        source: 'tunebat',
      };
      cache.set(term, merged);
      return merged;
    }
    // Nothing in the response was convincingly this track. Keep any key we
    // already had, and don't cache the miss so it is retried next run.
    onStatus?.(`No confident tunebat match for ${artist} - ${title}`);
    return fallback.keyName ? { ...fallback, bpm: '' } : { ...EMPTY };
  }
}

