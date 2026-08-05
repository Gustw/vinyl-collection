/**
 * Finding the entries that still need work: no key, no tempo, or a tempo that
 * cannot be right for the kind of record it is.
 *
 * A collection this size is never finished. Catalogues have gaps, some pressings
 * were never listed anywhere, and — most insidiously — some tempos are simply
 * wrong. A wrong tempo is worse than a missing one: a missing BPM shows up as a
 * blank and gets ignored, while a wrong one is quietly believed by every pitch
 * calculation, every beat-matched route and every "mixable tracks" list built
 * on top of it.
 *
 * The commonest wrong tempo by far is the half-time reading. Catalogues
 * routinely list a 165 BPM jungle roller as 82, because that is where the
 * kick pattern sits if you count it as hip-hop. On a turntable that is not a
 * matter of taste: you beat-match at 165, so a stored 82 makes the record look
 * unmixable with everything it actually mixes with.
 *
 * ## Why the tempo test only claims what it can prove
 *
 * Genres and styles here are *record-level* Discogs tags, and this collection is
 * full of records that carry several at once — a ragga jungle 12" is tagged
 * Reggae **and** Jungle, and legitimately holds a 78 BPM dub on the AA side and
 * a 170 BPM roller on the A. Even a record tagged only "Drum n Bass" routinely
 * carries a hip-hop interlude or a dub version.
 *
 * So "this tempo is outside the range for its genre" is, on its own, a bad
 * test: measured against the real collection it condemned a third of every
 * track, and most of those were simply a different kind of cut sharing a
 * sleeve. A maintenance list you stop trusting is worse than no list, so that
 * test was dropped.
 *
 * What is left are the two things that can actually be demonstrated:
 *
 *  - **Impossible tempos.** Below 40 or above 220 BPM, or not a number at all.
 *    No record is cut there; it is a data error whatever the genre.
 *  - **Half-time readings.** The tempo falls outside every band the record
 *    implies, *and* doubling it lands in the heart of a fast genre the record
 *    is tagged with. Catalogues list a 172 BPM roller as 86 because that is
 *    where the kick sits if you count it as hip-hop, and on a turntable that is
 *    not a matter of taste: you beat-match at 172, so the stored 86 hides the
 *    record from everything it belongs with.
 *
 * The half-time test runs in one direction only. There is no matching
 * convention that turns a 78 BPM dub into 156, so slow genres carry no
 * half-time window and are never accused — without that asymmetry every remix
 * on a reggae-tagged compilation would "halve" neatly into the reggae band and
 * be reported as an error.
 *
 * A track is judged against the union of every band its record's tags imply, so
 * on that ragga jungle 12" neither side is questioned. Umbrella tags that span
 * the whole tempo range — "Electronic", "Rock", "Jazz" — carry no band at all,
 * so they never contribute an opinion. The result misses some bad values rather
 * than crying wolf, which is the trade this filter wants.
 */

import { Track } from './models';

/** A kind of problem with an entry. */
export type TrackIssue = 'no-key' | 'no-bpm' | 'odd-bpm';

export const ISSUE_ORDER: TrackIssue[] = ['no-key', 'no-bpm', 'odd-bpm'];

/** Short labels for the filter chips. */
export const ISSUE_LABEL: Record<TrackIssue, string> = {
  'no-key': 'No key',
  'no-bpm': 'No BPM',
  'odd-bpm': 'Odd BPM',
};

/** What each chip means, for its tooltip. */
export const ISSUE_HELP: Record<TrackIssue, string> = {
  'no-key':
    'No Camelot key, so the track cannot appear in any mixable list or harmonic route.',
  'no-bpm': 'No tempo, so it cannot be beat-matched or pitch-checked against anything.',
  'odd-bpm':
    'A tempo that cannot be right: impossible for any record, or a half/double-time ' +
    'reading (a 170 BPM roller stored as 85), which silently hides the track from ' +
    'every beat-matched list it belongs in.',
};

/** A plausible tempo range for a family of genres. */
interface TempoBand {
  /** Human name, used in the explanation ("jungle / drum & bass"). */
  name: string;
  min: number;
  max: number;
  /** Normalised genre/style tags that select this band. */
  tags: string[];
  /**
   * The window a *doubled* tempo must land in for a half-time reading to be
   * claimed, for the fast genres where catalogues actually do this.
   *
   * Only the genuinely fast families have one. Catalogues list a 172 BPM roller
   * as 86 because that is where the kick sits if you count it as hip-hop; there
   * is no matching convention that turns a 78 BPM dub into 156, so slow families
   * get no window and are never accused. Without that asymmetry every remix on
   * a reggae-tagged compilation would "halve" neatly into the reggae band and
   * be reported as an error.
   *
   * The window is tighter than the band itself, so the claim is only made when
   * the doubled value lands in the heart of the genre rather than at its edge:
   * a 95 BPM interlude on a jungle 12" should not be talked into being a 190
   * BPM roller.
   */
  halfTime?: { min: number; max: number };
}

/**
 * Tempo bands by genre family, deliberately wider than the textbook figures.
 *
 * These are the bounds of what is *possible*, not what is typical: an intro
 * track, a half-speed dub version or a 1994 pressing that drifts will all sit
 * near the edge, and none of them is an error. The bands are set so that a
 * value inside them is never questioned and a value outside is almost always a
 * genuine mistake — most often the half/double confusion these ranges are wide
 * enough not to create by themselves.
 */
const BANDS: TempoBand[] = [
  {
    name: 'jungle / drum & bass',
    min: 145,
    max: 195,
    halfTime: { min: 152, max: 186 },
    tags: [
      'jungle',
      'drumnbass',
      'dnb',
      'raggajungle',
      'oldschooljungle',
      'neurofunk',
      'jumpup',
      'techstep',
      'hardstep',
      'darkstep',
      'liquidfunk',
      'drillnbass',
      'atmosphericdnb',
    ],
  },
  {
    name: 'reggae / dub',
    min: 55,
    max: 115,
    tags: ['reggae', 'rootsreggae', 'dub', 'dubpoetry', 'loversrock', 'rocksteady', 'dancehall'],
  },
  { name: 'ska', min: 100, max: 180, tags: ['ska', 'skaboogie'] },
  {
    name: 'goa / psytrance',
    min: 122,
    max: 160,
    tags: ['goatrance', 'psytrance', 'psychedelictrance', 'fullon', 'darkpsy'],
  },
  { name: 'trance', min: 122, max: 155, tags: ['trance', 'progressivetrance', 'hardtrance'] },
  {
    name: 'techno / acid',
    min: 115,
    max: 155,
    tags: ['techno', 'acid', 'acidhouse', 'minimal', 'minimaltechno', 'techhouse', 'detroittechno'],
  },
  {
    name: 'house',
    min: 105,
    max: 138,
    tags: ['house', 'deephouse', 'progressivehouse', 'discohouse', 'garagehouse', 'chicagohouse'],
  },
  { name: 'disco / funk 12"', min: 95, max: 132, tags: ['disco', 'italodisco', 'boogie'] },
  {
    name: 'hardcore / tekno',
    min: 145,
    max: 220,
    halfTime: { min: 155, max: 210 },
    tags: [
      'hardcore',
      'gabber',
      'hardstyle',
      'freetekno',
      'tekno',
      'speedcore',
      'breakcore',
      'happyhardcore',
      'ukhardcore',
    ],
  },
  {
    name: 'breakbeat',
    min: 105,
    max: 155,
    tags: ['breakbeat', 'breaks', 'bigbeat', 'nuskoolbreaks', 'progressivebreaks'],
  },
  { name: 'dubstep / grime', min: 125, max: 150, tags: ['dubstep', 'grime'] },
  {
    name: 'garage',
    min: 122,
    max: 145,
    tags: ['ukgarage', 'garage', 'twostep', 'speedgarage', 'bassline'],
  },
  { name: 'electro', min: 112, max: 148, tags: ['electro', 'electrofunk', 'miamibass'] },
  {
    name: 'hip hop',
    min: 60,
    max: 118,
    tags: ['hiphop', 'triphop', 'boombap', 'rap', 'gangsta', 'instrumental'],
  },
];

/**
 * Tempos no record is cut at, whatever it is.
 *
 * Outside this, the value is not a genre judgement but a plain data error — a
 * duration parsed as a tempo, a stray digit — so it is flagged even when the
 * record carries no tag we recognise.
 */
const ABSURD = { min: 40, max: 220 } as const;

/**
 * Folds a Discogs tag to a comparable key: lower case, "&"/"and" read as "n",
 * everything else stripped. "Drum & Bass", "Drum And Bass" and "Drum n Bass"
 * are the same tag written three ways, and all three occur.
 */
function normaliseTag(tag: string): string {
  return (tag || '')
    .toLowerCase()
    .replace(/&/g, ' n ')
    .replace(/\band\b/g, ' n ')
    .replace(/[^a-z]/g, '');
}

/** Every tempo band implied by a record's genres and styles (may be empty). */
export function tempoBandsFor(tags: string[]): TempoBand[] {
  const wanted = new Set(tags.map(normaliseTag).filter(Boolean));
  if (!wanted.size) return [];
  return BANDS.filter((b) => b.tags.some((t) => wanted.has(t)));
}

/** True when `bpm` sits inside any of the bands. */
function inAnyBand(bpm: number, bands: TempoBand[]): boolean {
  return bands.some((b) => bpm >= b.min && bpm <= b.max);
}

/** The fast-genre band a doubled tempo would land in, if any. */
function halfTimeBandFor(doubled: number, bands: TempoBand[]): TempoBand | null {
  return (
    bands.find((b) => b.halfTime && doubled >= b.halfTime.min && doubled <= b.halfTime.max) ?? null
  );
}

/** The verdict on a track's tempo: why it looks wrong, or '' when it looks fine. */
export function bpmProblem(t: Pick<Track, 'bpm' | 'genres' | 'styles'>): string {
  const raw = (t.bpm || '').trim();
  if (!raw) return ''; // that's "no BPM", a different issue

  const bpm = Number(raw);
  if (!Number.isFinite(bpm) || bpm <= 0) {
    return `"${raw}" is not a usable tempo.`;
  }
  if (bpm < ABSURD.min || bpm > ABSURD.max) {
    return `${trim(bpm)} BPM is outside anything a record is cut at (${ABSURD.min}–${ABSURD.max}).`;
  }

  const bands = tempoBandsFor([...t.genres, ...t.styles]);
  if (!bands.length) return ''; // nothing on the sleeve tells us what to expect
  if (inAnyBand(bpm, bands)) return '';

  // Half-time: the tempo is outside every band the record implies, and doubling
  // it lands in the heart of a fast genre it is tagged with. That arithmetic
  // coincidence is the fingerprint of the error rather than a matter of taste —
  // and the fix it implies is one keystroke.
  const doubled = bpm * 2;
  const fast = halfTimeBandFor(doubled, bands);
  if (fast) {
    return (
      `${trim(bpm)} BPM looks like a half-time reading — doubled it is ` +
      `${trim(doubled)}, which fits ${fast.name} (${fast.min}–${fast.max}). ` +
      `On the deck you would beat-match at ${trim(doubled)}, so the stored ` +
      `value hides this record from everything it actually mixes with.`
    );
  }

  // Outside every band, but not a half-time reading either. Left alone on
  // purpose: see the module note — on a record whose tags span several tempo
  // families this is far more often a different kind of cut than a mistake.
  return '';
}

/** Drops a pointless ".0" so messages read like the badges do. */
function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/**
 * Everything wrong with one entry.
 *
 * "No key" means no Camelot code rather than no key text: the code is what the
 * mixable lists, the routes and the colour coding are all computed from, so a
 * key name nothing could be derived from is just as unusable as a blank.
 */
export function trackIssues(t: Track): TrackIssue[] {
  const issues: TrackIssue[] = [];
  if (!t.camelot) issues.push('no-key');
  if (!(t.bpm || '').trim()) issues.push('no-bpm');
  else if (bpmProblem(t)) issues.push('odd-bpm');
  return issues;
}

/** True when the track has at least one of the issues asked about. */
export function hasAnyIssue(t: Track, wanted: readonly string[]): boolean {
  if (!wanted.length) return true;
  if (!t.camelot && wanted.includes('no-key')) return true;
  const bpm = (t.bpm || '').trim();
  if (!bpm) return wanted.includes('no-bpm');
  return wanted.includes('odd-bpm') && !!bpmProblem(t);
}

/** One line per problem, for the warning badge's tooltip. */
export function issueReasons(t: Track): string[] {
  const out: string[] = [];
  if (!t.camelot) out.push(ISSUE_HELP['no-key']);
  if (!(t.bpm || '').trim()) out.push(ISSUE_HELP['no-bpm']);
  else {
    const problem = bpmProblem(t);
    if (problem) out.push(problem);
  }
  return out;
}










