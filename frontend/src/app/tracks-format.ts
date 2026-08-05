import { Rec, Track } from './models';

/**
 * Renders records to the tracks.txt plain-text format (mirrors the Java tool).
 *
 * Per-track metadata lives in a single trailing bracket block of `Name: value`
 * pairs separated by `|`. Older files carry only `Key` and `BPM`; `Pos`, `Time`
 * and `Manual` were added later and every field is optional on the way back in,
 * so files written by any version read correctly in all of them.
 */
export function renderTracksTxt(records: Rec[]): string {
  const lines: string[] = [];
  for (const r of records) {
    lines.push(`=== ${r.title} -- ${r.artist} ===`);
    if (r.releaseId) lines.push(`  ID: ${r.releaseId}`);
    if (r.genres.length) lines.push(`  Genre: ${r.genres.join(', ')}`);
    if (r.styles.length) lines.push(`  Style: ${r.styles.join(', ')}`);
    if (r.year) lines.push(`  Year: ${r.year}`);
    if (r.labels.length) lines.push(`  Label: ${r.labels.join(', ')}`);
    if (r.artwork) lines.push(`  Art: ${r.artwork}`);
    if (!r.tracks.length) {
      lines.push('  (no tracks found)');
    } else {
      let n = 0;
      for (const t of r.tracks) {
        n++;
        let s = `  ${String(n).padStart(2, ' ')}. ${t.title} - ${t.artist}`;
        const meta: string[] = [];
        if (t.position) meta.push(`Pos: ${t.position}`);
        if (t.duration) meta.push(`Time: ${t.duration}`);
        if (t.keyText) meta.push(`Key: ${t.keyText}`);
        if (t.bpm) meta.push(`BPM: ${t.bpm}`);
        const manual = manualFields(t);
        if (manual) meta.push(`Manual: ${manual}`);
        if (meta.length) s += ` [${meta.join(' | ')}]`;
        lines.push(s);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Which fields were set by hand, as "key", "bpm" or "key,bpm" ('' for none).
 *
 * This is what makes a correction outrank the catalogues everywhere rather than
 * only in the browser it was typed in. It is written last in the block so the
 * fields older readers care about come first, and only over values that are
 * actually present — a lock on an empty field would say nothing useful and
 * would look like corruption to anyone reading the file by eye.
 */
function manualFields(t: Track): string {
  const parts: string[] = [];
  if (t.manualKey && t.keyText) parts.push('key');
  if (t.manualBpm && t.bpm) parts.push('bpm');
  return parts.join(',');
}

