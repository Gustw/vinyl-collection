/**
 * Checks the "needs attention" filter: what counts as an incomplete or wrong
 * entry, and — just as important — what doesn't.
 *
 * Run with `npm run check:quality`.
 *
 * Two things are tested. First the rules, against hand-written cases: the
 * half-time jungle reading that has to be caught, and the ragga jungle 12"
 * whose 78 BPM dub must *not* be, because its record is tagged Reggae as well.
 *
 * Then the whole real collection is run through and summarised. That second
 * part is calibration rather than assertion — a genre band that suddenly
 * condemns a tenth of the records is wrong about the music, not about the
 * records, and the only way to notice is to look at the number.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTracksTxt } from '../src/app/collection.service';
import { Track } from '../src/app/models';
import { bpmProblem, trackIssues } from '../src/app/quality';

/**
 * The collection to calibrate against: the repo's tracks.txt, or the snapshot
 * bundled into the app if that isn't there. Resolved from the working directory
 * rather than from `import.meta.url`, because this file is bundled into
 * node_modules/.cache before it runs and its own path means nothing by then.
 */
function findTracksTxt(): string | null {
  const cwd = process.cwd();
  const candidates = [
    join(cwd, '..', 'tracks.txt'),
    join(cwd, 'src', 'assets', 'tracks.txt'),
    join(cwd, 'tracks.txt'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

// parseTracksTxt reads the key cache from localStorage; under Node there is
// none, so a stub that always misses keeps it on the plain-file path.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

let failures = 0;

function check(what: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function track(o: Partial<Track>): Track {
  return {
    id: 0, title: 'T', artist: 'A', position: '', duration: '', keyName: '',
    camelot: '', keyText: '', bpm: '', manualKey: false, manualBpm: false,
    recordTitle: 'R', recordArtist: 'A', genres: [], styles: [], year: 0,
    labels: [], artwork: '', releaseId: '1', ...o,
  };
}

/** Asserts that a tempo on a record with these tags is / isn't questioned. */
function tempo(what: string, bpm: string, tags: string[], shouldFlag: boolean): void {
  const t = track({ bpm, genres: tags });
  const problem = bpmProblem(t);
  check(what, !!problem === shouldFlag, problem || 'accepted');
}

console.log('\nThe half/double-time readings that have to be caught');
tempo('a jungle roller stored at half time', '82', ['Jungle'], true);
tempo('drum & bass stored at half time', '81', ['Drum n Bass'], true);
tempo('"Drum & Bass" spelled with an ampersand', '81', ['Drum & Bass'], true);
tempo('a duration parsed as a tempo', '5', ['Reggae'], true);
tempo('a tempo no record is cut at', '246', ['Reggae'], true);
tempo('a tempo that is not a number', 'n/a', ['Jungle'], true);
tempo('an impossible tempo even with no tags at all', '900', [], true);

console.log('\nWhat must not be questioned');
tempo('a jungle roller at its real tempo', '172', ['Jungle'], false);
tempo('a dub at its real tempo', '78', ['Reggae', 'Dub'], false);
tempo(
  'a 78 BPM dub on a ragga jungle 12" (tagged both)',
  '78',
  ['Reggae', 'Jungle'],
  false
);
tempo(
  'a 170 BPM roller on the same 12"',
  '170',
  ['Reggae', 'Jungle'],
  false
);
tempo('anything at all on an untagged record', '96', [], false);
tempo('anything at all under an umbrella tag', '96', ['Electronic'], false);
tempo('a 96 BPM cut on a rock LP', '96', ['Rock', 'Psychedelic Rock'], false);
tempo('an edge-of-band jungle intro', '148', ['Jungle'], false);
tempo('a slow house record', '112', ['House'], false);
// The deliberate blind spots. Outside the band, but not a half-time reading and
// not impossible either — on a record whose tags span several tempo families
// this is far more often a different kind of cut than a mistake.
tempo('a 133 BPM cut on a drum & bass 12"', '133', ['Drum n Bass'], false);
tempo('a 113 BPM cut on a jungle 12"', '113', ['Jungle'], false);
// The half-time test runs one way only: slow genres are never accused of being
// fast ones counted twice, or every remix on a reggae LP would be flagged.
tempo('a 135 BPM remix on a reggae compilation', '135', ['Reggae', 'Dub'], false);
tempo('a 156 BPM cut on a reggae 7"', '156', ['Reggae'], false);
// Doubling has to land in the *heart* of the fast genre, not at its edge.
tempo('a 95 BPM interlude on a jungle 12"', '95', ['Jungle'], false);

console.log('\nThe issue list itself');
{
  const t = track({ bpm: '82', genres: ['Jungle'] });
  check('no key and an odd BPM are both reported', JSON.stringify(trackIssues(t)) === '["no-key","odd-bpm"]', trackIssues(t).join(', '));
}
{
  const t = track({ camelot: '8A', keyText: 'A minor (8A)' });
  check('a missing BPM is "no-bpm", not "odd-bpm"', JSON.stringify(trackIssues(t)) === '["no-bpm"]', trackIssues(t).join(', '));
}
{
  const t = track({ camelot: '8A', keyText: 'A minor (8A)', bpm: '172', genres: ['Jungle'] });
  check('a complete entry has no issues', trackIssues(t).length === 0, trackIssues(t).join(', '));
}

// --- calibration against the real collection --------------------------------

console.log('\nThe collection as it stands');
const path = findTracksTxt();
if (!path) {
  console.log('  (no tracks.txt found — skipping the calibration pass)');
  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nAll checks passed\n');
  process.exit(failures ? 1 : 0);
}
const text = readFileSync(path, 'utf8');
const records = parseTracksTxt(text);
const tracks = records.flatMap((r) => r.tracks);

const counts = { 'no-key': 0, 'no-bpm': 0, 'odd-bpm': 0 };
const odd: Track[] = [];
for (const t of tracks) {
  for (const i of trackIssues(t)) {
    counts[i]++;
    if (i === 'odd-bpm') odd.push(t);
  }
}
const pct = (n: number) => ((n / Math.max(1, tracks.length)) * 100).toFixed(1) + '%';
console.log(`  ${tracks.length} tracks in ${records.length} records`);
console.log(`  no key   ${String(counts['no-key']).padStart(5)}  ${pct(counts['no-key'])}`);
console.log(`  no BPM   ${String(counts['no-bpm']).padStart(5)}  ${pct(counts['no-bpm'])}`);
console.log(`  odd BPM  ${String(counts['odd-bpm']).padStart(5)}  ${pct(counts['odd-bpm'])}`);

console.log('\n  A sample of the odd tempos, to eyeball the rules:');
for (const t of odd.slice(0, 12)) {
  console.log(`    ${t.bpm.padStart(4)} BPM  ${t.title} — ${[...t.genres, ...t.styles].join(', ')}`);
  console.log(`             ${bpmProblem(t)}`);
}

// A rule that condemns a large slice of the collection is describing the rule,
// not the records. The filter is meant to be a to-do list, not a verdict.
const share = counts['odd-bpm'] / Math.max(1, tracks.length);
check(
  '\n  the odd-BPM rule stays a to-do list rather than a verdict',
  share < 0.1,
  `${pct(counts['odd-bpm'])} of tracks flagged`
);

console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);







