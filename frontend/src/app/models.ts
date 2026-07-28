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

