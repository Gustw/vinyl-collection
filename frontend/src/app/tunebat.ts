import { AppConfig } from './config.service';

export interface KeyInfo {
  keyName: string; // e.g. "A minor"
  camelot: string; // e.g. "8A"
  keyText: string; // e.g. "A minor (8A)"
  bpm: string; // e.g. "128"
}

const EMPTY: KeyInfo = { keyName: '', camelot: '', keyText: '', bpm: '' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Parses a Retry-After header (delta-seconds or HTTP-date) into ms, clamped to
 * a sane range. Returns null when the header is absent/unreadable (e.g. a proxy
 * that doesn't expose it) so the caller can fall back to a default wait.
 */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('Retry-After');
  if (!raw) return null;
  const secs = Number(raw);
  let ms: number;
  if (Number.isFinite(secs)) ms = secs * 1000;
  else {
    const when = Date.parse(raw);
    if (Number.isNaN(when)) return null;
    ms = when - Date.now();
  }
  return Math.max(1000, Math.min(ms, 120000));
}

/** Wraps a target URL in the configured CORS proxy (if any). */
function proxied(url: string, cfg: AppConfig): string {
  const p = cfg.corsProxy.trim();
  if (!p) return url;
  // Convention: proxy prefix expects a URL-encoded target appended.
  return p + encodeURIComponent(url);
}

function cacheGet(term: string): KeyInfo | null {
  try {
    const raw = localStorage.getItem('tunebat.' + term);
    if (!raw) return null;
    return JSON.parse(raw) as KeyInfo;
  } catch {
    return null;
  }
}

function cacheSet(term: string, info: KeyInfo): void {
  try {
    localStorage.setItem('tunebat.' + term, JSON.stringify(info));
  } catch {
    /* ignore */
  }
}

/**
 * Returns a previously cached lookup for this artist/title, or null. Used to
 * rehydrate the collection after a page reload so progress isn't lost when it
 * hasn't been committed to GitHub yet.
 */
export function cachedKeyInfo(artist: string, title: string): KeyInfo | null {
  return cacheGet(`${artist} ${title}`.trim());
}

function parseKeyInfo(json: any): KeyInfo {
  const items = json?.data?.items;
  if (!Array.isArray(items) || !items.length) return { ...EMPTY };
  const item = items[0];
  let key = String(item?.k || '').trim();
  const camelot = String(item?.c || '').trim();
  let bpm = '';
  const b = Number(item?.b);
  if (Number.isFinite(b)) {
    const rounded = Math.round(b);
    if (rounded > 0) bpm = String(rounded);
  }
  if (!key) return { keyName: '', camelot, keyText: '', bpm };
  // Normalise ♭/♯ to ASCII so it matches the rest of the pipeline.
  key = key.replace(/\u266d/g, 'b').replace(/\u266f/g, '#');
  const keyText = camelot ? `${key} (${camelot})` : key;
  return { keyName: key, camelot, keyText, bpm };
}

/**
 * Looks up a track's key + BPM on tunebat. Results (including "not found",
 * only when it actually reached the API) are cached in localStorage so
 * re-runs skip them. Returns empty fields when nothing is found or the
 * request is blocked (e.g. CORS without a proxy).
 *
 * On HTTP 429 it backs off (honouring Retry-After, else 60s like the Java
 * tool) and retries the same term instead of hammering the API, reporting the
 * wait via the optional onStatus callback.
 */
export async function lookupKey(
  cfg: AppConfig,
  artist: string,
  title: string,
  onStatus?: (message: string) => void
): Promise<KeyInfo> {
  const term = `${artist} ${title}`.trim();
  const cached = cacheGet(term);
  if (cached && cached.bpm) return cached; // fully cached
  const fallback = cached ?? { ...EMPTY };
  const keep = () => (fallback.keyName ? { ...fallback, bpm: '' } : { ...EMPTY });

  const url =
    'https://api.tunebat.com/api/tracks/search?term=' + encodeURIComponent(term);
  const target = proxied(url, cfg);

  const MAX_RATE_WAITS = 5;
  let rateWaits = 0;
  while (true) {
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
      await sleep(wait);
      continue; // retry the same term
    }

    if (res.status !== 200) return keep();

    let json: any;
    try {
      json = await res.json();
    } catch {
      return keep();
    }
    const info = parseKeyInfo(json);
    // Merge onto anything we already had so we never drop a known field, and
    // cache whenever we learned a key OR a BPM so a page reload can restore it.
    if (info.keyName || info.bpm) {
      const merged: KeyInfo = {
        keyName: info.keyName || fallback.keyName,
        camelot: info.camelot || fallback.camelot,
        keyText: info.keyText || fallback.keyText,
        bpm: info.bpm || fallback.bpm,
      };
      cacheSet(term, merged);
      return merged;
    }
    // Empty result: keep any key we already had, don't cache the miss.
    return fallback.keyName ? { ...fallback, bpm: '' } : info;
  }
}

