export interface Track {
  id: number;
  title: string;
  artist: string;
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

