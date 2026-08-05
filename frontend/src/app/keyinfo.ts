/**
 * The vocabulary shared by every key/BPM source (tunebat, Beatport, …).
 *
 * Each source answers the same question — "what key and tempo is this
 * recording?" — and must answer it in the same shape, so the rest of the app
 * never has to care which one replied. The plumbing every source needs is here
 * too: the CORS-proxy wrapper, Retry-After parsing, and a namespaced
 * localStorage cache so one source's answers can never be mistaken for
 * another's.
 */

import { AppConfig } from './config.service';

/** Which service produced an answer. Absent on entries cached before sources existed. */
export type KeySource = 'beatport' | 'tunebat';

export interface KeyInfo {
  keyName: string; // e.g. "A minor"
  camelot: string; // e.g. "8A"
  keyText: string; // e.g. "A minor (8A)"
  bpm: string; // e.g. "128"
  /**
   * The track the source actually matched, e.g. "Original Nuttah - Shy FX".
   * Empty when nothing matched, or when the answer predates verification.
   */
  matched?: string;
  /** Confidence of that match, 0..1. Absent when unverified. */
  confidence?: number;
  /** Which service answered. */
  source?: KeySource;
}

export const EMPTY: KeyInfo = { keyName: '', camelot: '', keyText: '', bpm: '' };

/** True when a lookup actually learned something worth keeping. */
export function hasAnswer(info: KeyInfo | null | undefined): boolean {
  return !!info && (!!info.bpm || !!info.keyName);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Parses a Retry-After header (delta-seconds or HTTP-date) into ms, clamped to
 * a sane range. Returns null when the header is absent/unreadable (e.g. a proxy
 * that doesn't expose it) so the caller can fall back to a default wait.
 */
export function retryAfterMs(res: Response): number | null {
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
export function proxied(url: string, cfg: AppConfig): string {
  const p = (cfg.corsProxy || '').trim();
  if (!p) return url;
  // Convention: proxy prefix expects a URL-encoded target appended.
  return p + encodeURIComponent(url);
}

/** A namespaced localStorage cache of lookups for one source. */
export interface KeyCache {
  get(term: string): KeyInfo | null;
  set(term: string, info: KeyInfo): void;
}

/**
 * Builds a cache under its own key prefix. Prefixes are versioned: when the
 * meaning of a stored answer changes (e.g. match verification is added) the
 * version is bumped so the old, untrustworthy entries are simply never read
 * again rather than silently believed.
 */
export function makeCache(prefix: string): KeyCache {
  return {
    get(term: string): KeyInfo | null {
      try {
        const raw = localStorage.getItem(prefix + term);
        if (!raw) return null;
        return JSON.parse(raw) as KeyInfo;
      } catch {
        return null;
      }
    },
    set(term: string, info: KeyInfo): void {
      try {
        localStorage.setItem(prefix + term, JSON.stringify(info));
      } catch {
        /* ignore quota errors — losing a cache entry only costs a re-fetch */
      }
    },
  };
}

/** Optional behaviour for a lookup, shared by every source. */
export interface LookupOptions {
  /** Progress/status line for the UI. */
  onStatus?: (message: string) => void;
  /**
   * Ignore the cached answer and re-ask the API — used by the "re-fetch all
   * keys/BPM" passes that repair values that were wrong. The fresh answer
   * replaces the cache entry.
   */
  force?: boolean;
  /**
   * Polled during the rate-limit backoff so a user-cancelled job doesn't stay
   * stuck in a minute-long wait.
   */
  isCancelled?: () => boolean;
  /**
   * Called with how long this lookup actually spent parked on a 429. Lets the
   * caller separate real work from waiting when estimating how long a run
   * still has to go.
   */
  onRateLimitWait?: (ms: number) => void;
}

/**
 * Normalises a key name to the app's house style, "A minor" / "Bb major".
 *
 * Sources disagree about spelling: tunebat writes "A♭ Minor", Beatport writes
 * "Ab min" (and, on newer records, "A Minor"). They all have to fold to one
 * form, because the key text is what the UI matches, sorts and colour-codes on.
 * Anything unrecognised is passed through untouched rather than mangled.
 */
export function normaliseKeyName(raw: string): string {
  const s = (raw || '')
    .replace(/\u266d/g, 'b')
    .replace(/\u266f/g, '#')
    // Written-out accidentals ("A flat minor", "D sharp minor") fold to the
    // symbol form so the rest of the pipeline sees one spelling.
    .replace(/\s*\bflat\b/gi, 'b')
    .replace(/\s*\bsharp\b/gi, '#')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  const m = /^([A-Ga-g])\s*([b#]?)\s*(maj(?:or)?|min(?:or)?|m)?$/i.exec(s);
  if (!m) return s;
  const note = m[1].toUpperCase() + (m[2] || '');
  const q = (m[3] || '').toLowerCase();
  if (!q) return note;
  return `${note} ${q.startsWith('maj') ? 'major' : 'minor'}`;
}

/** The display form of a key, e.g. "A minor (8A)". */
export function keyTextOf(keyName: string, camelot: string): string {
  if (!keyName) return '';
  return camelot ? `${keyName} (${camelot})` : keyName;
}

/** Rounds a numeric BPM to the app's string form, or '' when it isn't usable. */
export function bpmText(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const rounded = Math.round(n);
  return rounded > 0 ? String(rounded) : '';
}

