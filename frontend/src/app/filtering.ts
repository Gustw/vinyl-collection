import { Track } from './models';
import { Filters } from './filter-state.service';
import { camelotOfQuery } from './camelot';
import { hasAnyIssue } from './quality';

/**
 * True if `trackBpm` is within `range` of `refBpm`. When `doubleHalf` is set,
 * candidates at double or half tempo are normalised to the reference tempo
 * before comparing (so e.g. 70 BPM matches a 140 BPM reference).
 */
export function bpmMatches(
  trackBpm: number,
  refBpm: number,
  range: number,
  doubleHalf: boolean
): boolean {
  if (Math.abs(trackBpm - refBpm) <= range) return true;
  if (doubleHalf) {
    if (Math.abs(trackBpm * 2 - refBpm) <= range) return true; // candidate ≈ half of ref
    if (Math.abs(trackBpm / 2 - refBpm) <= range) return true; // candidate ≈ double of ref
  }
  return false;
}

/**
 * True if a track satisfies all active facets of the given filters.
 * `refBpm` is the reference BPM used by the BPM-difference filter (detail view).
 * `effectiveCamelot` overrides the key used for the key facet (detail view uses
 * the pitch-adjusted/resulting key when "account for key change" is on).
 */
export function matchesTrack(t: Track, f: Filters, refBpm?: number, effectiveCamelot?: string): boolean {
  if (f.search) {
    const q = f.search.toLowerCase();
    const hay = (
      t.title +
      ' ' +
      t.artist +
      ' ' +
      t.keyText +
      ' ' +
      t.recordTitle +
      ' ' +
      t.recordArtist +
      ' ' +
      t.labels.join(' ') +
      ' ' +
      (t.year ? String(t.year) : '')
    ).toLowerCase();
    if (!hay.includes(q)) {
      // A search that names a key should find that key however the track spells
      // it: "Bb minor" and "A# minor" are the same key, and so is "3A". Only
      // consulted when the plain text search misses, so it can never narrow a
      // result that already matched.
      const wanted = camelotOfQuery(f.search);
      if (!wanted || wanted !== (effectiveCamelot ?? t.camelot)) return false;
    }
  }
  if (f.genres.length && !f.genres.some((g) => t.genres.includes(g))) return false;
  if (f.styles.length && !f.styles.some((s) => t.styles.includes(s))) return false;
  if (f.keys.length && !f.keys.includes(effectiveCamelot ?? t.camelot)) return false;
  // The maintenance facet: keep only entries that still need work. Judged on
  // the track's own stored key, never the pitch-adjusted one — the question is
  // what is written in tracks.txt, not how it would sound at +6%.
  if (f.issues.length && !hasAnyIssue(t, f.issues)) return false;
  if (f.yearMin != null || f.yearMax != null) {
    if (!t.year) return false; // unknown year excluded while a year bound is set
    if (f.yearMin != null && t.year < f.yearMin) return false;
    if (f.yearMax != null && t.year > f.yearMax) return false;
  }
  if (f.bpmEnabled && refBpm != null && !Number.isNaN(refBpm)) {
    const b = parseFloat(t.bpm);
    if (Number.isNaN(b)) return false;
    if (!bpmMatches(b, refBpm, f.bpmRange, f.bpmDoubleHalf)) return false;
  }
  return true;
}

