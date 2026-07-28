import { Rec } from './models';

/** Renders records to the tracks.txt plain-text format (mirrors the Java tool). */
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
        const hasKey = !!t.keyText;
        const hasBpm = !!t.bpm;
        if (hasKey || hasBpm) {
          s += ' [';
          if (hasKey) s += `Key: ${t.keyText}`;
          if (hasBpm) s += (hasKey ? ' | ' : '') + `BPM: ${t.bpm}`;
          s += ']';
        }
        lines.push(s);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

