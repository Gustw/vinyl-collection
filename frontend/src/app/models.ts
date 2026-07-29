export interface Track {
  id: number;
  title: string;
  artist: string;
  /**
   * Where the track physically sits on the record, as printed on the label:
   * "A1", "B2", "AA" ("" if unknown). The one piece of metadata a digital
   * library has no use for and a vinyl DJ cannot work without — it's how you
   * find the cut once the sleeve is in your hand.
   */
  position: string;
  /** Track length as printed, e.g. "6:32" ("" if unknown). */
  duration: string;
  /** e.g. "A minor" ("" if unknown) */
  keyName: string;
  /** e.g. "8A" ("" if unknown) */
  camelot: string;
  /** original text e.g. "A minor (8A)" ("" if unknown) */
  keyText: string;
  /** beats per minute as text, e.g. "117" ("" if unknown) */
  bpm: string;
  recordTitle: string;
  recordArtist: string;
  genres: string[];
  styles: string[];
  /** release year (0 if unknown) */
  year: number;
  /** record label(s) */
  labels: string[];
  /** cover image URL of the record ("" if none) */
  artwork: string;
  /** Discogs release id of the owning record ("" if unknown) */
  releaseId: string;
}

export interface Rec {
  /** Discogs release id ("" if unknown) */
  releaseId: string;
  title: string;
  artist: string;
  genres: string[];
  styles: string[];
  /** release year (0 if unknown) */
  year: number;
  /** record label(s) */
  labels: string[];
  /** cover image URL ("" if none) */
  artwork: string;
  tracks: Track[];
}

/**
 * A named, ordered selection of tracks — the digital equivalent of the box you
 * actually carry to a gig ("Friday warm-up", "peak time", "the 14th").
 *
 * Membership is stored as artist/title keys rather than track ids, because ids
 * are re-assigned every time tracks.txt is parsed. A key survives re-imports,
 * re-orderings and even a record being replaced by a different pressing.
 */
export interface Crate {
  id: string;
  name: string;
  /** Track keys (see trackKey()), in the order they should be played. */
  trackKeys: string[];
}

/** Stable identity of a track across reloads: its artist + title, folded. */
export function trackKey(t: Pick<Track, 'artist' | 'title'>): string {
  return `${(t.artist || '').trim()}\u0000${(t.title || '').trim()}`.toLowerCase();
}

/**
 * Seconds in a printed duration: "6:32" → 392, "1:02:03" → 3723.
 * Returns 0 for anything unparseable, so unknown lengths simply don't count
 * towards a total rather than poisoning it with NaN.
 */
export function durationSeconds(duration: string): number {
  const parts = (duration || '').trim().split(':');
  if (parts.length < 2 || parts.length > 3) return 0;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  return parts.length === 3
    ? nums[0] * 3600 + nums[1] * 60 + nums[2]
    : nums[0] * 60 + nums[1];
}

/** Seconds as "6:32" / "1:02:03" (the inverse of `durationSeconds`). */
export function formatRuntime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Total printed runtime of some tracks, in seconds (unknown lengths count 0). */
export function totalRuntime(tracks: Pick<Track, 'duration'>[]): number {
  return tracks.reduce((n, t) => n + durationSeconds(t.duration), 0);
}

