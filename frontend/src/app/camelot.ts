/**
 * Harmonic mixing helpers based on the Camelot wheel.
 * Codes look like "8A" (minor) / "8B" (major), numbers 1..12.
 */

const CAMELOT_RE = /^(\d{1,2})([AB])$/;

/**
 * Folds any wheel number back into 1..12.
 *
 * The `+ 12` is not enough on its own: `shiftCamelot` moves seven positions per
 * semitone, so a two-semitone drop asks for position -13 and JavaScript's `%`
 * keeps the sign. Taking the modulo twice makes it safe for any input, and
 * without it a record pitched down two semitones was labelled "0A" or "-1A".
 */
function wrap(n: number): number {
  return ((((n - 1) % 12) + 12) % 12) + 1;
}

/**
 * CSS colour-group class for a Camelot code, based on its wheel number (1..12).
 * Returns '' for a missing/invalid code. Pairs with `.key-badge.cam-N` /
 * `.big-key.cam-N` styles so keys are colour-coded around the wheel.
 */
export function camelotClass(code: string): string {
  const m = CAMELOT_RE.exec((code || '').trim());
  return m ? `cam-${Number(m[1])}` : '';
}

/** All 24 Camelot codes in wheel order (1A, 1B, 2A, … 12B), for pickers. */
export const CAMELOT_CODES: string[] = Array.from({ length: 12 }, (_, i) => [
  `${i + 1}A`,
  `${i + 1}B`,
]).flat();

// Standard Camelot ↔ musical key names (minor = A, major = B), indexed 1..12.
const MINOR_KEY: Record<number, string> = {
  1: 'G# minor', 2: 'D# minor', 3: 'A# minor', 4: 'F minor', 5: 'C minor',
  6: 'G minor', 7: 'D minor', 8: 'A minor', 9: 'E minor', 10: 'B minor',
  11: 'F# minor', 12: 'C# minor',
};
const MAJOR_KEY: Record<number, string> = {
  1: 'B major', 2: 'F# major', 3: 'Db major', 4: 'Ab major', 5: 'Eb major',
  6: 'Bb major', 7: 'F major', 8: 'C major', 9: 'G major', 10: 'D major',
  11: 'A major', 12: 'E major',
};

/** Musical key name for a Camelot code, e.g. "8A" -> "A minor". '' if invalid. */
export function camelotToKeyName(code: string): string {
  const m = CAMELOT_RE.exec((code || '').trim());
  if (!m) return '';
  const n = Number(m[1]);
  return m[2] === 'A' ? MINOR_KEY[n] ?? '' : MAJOR_KEY[n] ?? '';
}

/**
 * Camelot code of the parallel key (same root note, opposite mode).
 * Minor `nA` -> major `(n+3)B`; major `nB` -> minor `(n-3)A`.
 * e.g. 8A (A minor) -> 11B (A major); 8B (C major) -> 5A (C minor).
 */
export function parallelCamelot(code: string): string {
  const m = CAMELOT_RE.exec(code);
  if (!m) return '';
  const n = Number(m[1]);
  return m[2] === 'A' ? `${wrap(n + 3)}B` : `${wrap(n - 3)}A`;
}

/** Returns the set of Camelot codes considered compatible for mixing. */
export function mixableCamelot(code: string): string[] {
  const m = CAMELOT_RE.exec(code);
  if (!m) return [];
  const n = Number(m[1]);
  const letter = m[2];
  const other = letter === 'A' ? 'B' : 'A';
  return [
    `${n}${letter}`,        // same key
    `${wrap(n + 1)}${letter}`, // +1 (energy up)
    `${wrap(n - 1)}${letter}`, // -1 (energy down)
    `${n}${other}`,         // relative major/minor
    parallelCamelot(code),  // same root note (parallel major/minor)
    `${wrap(n + 7)}${letter}`, // +1 semitone  (energy boost)
    `${wrap(n + 2)}${letter}`, // +2 semitones (energy boost)
    `${wrap(n - 7)}${letter}`, // -1 semitone  (energy drop)
    `${wrap(n - 2)}${letter}`, // -2 semitones (energy drop)
  ];
}

/**
 * Folds a tempo ratio into the nearest octave (between 2^-0.5 and 2^0.5),
 * so that beat-matching at half/double tempo counts as *no* pitch change.
 * e.g. 162/80 = 2.025 folds to 1.0125 (only the residual +2 BPM counts).
 */
export function foldTempoRatio(ratio: number): number {
  if (!(ratio > 0)) return 1;
  let r = ratio;
  while (r >= Math.SQRT2) r /= 2;
  while (r < Math.SQRT1_2) r *= 2;
  return r;
}

/**
 * Semitones a track at `fromBpm` must be pitched to beat-match `toBpm`,
 * folding octaves so half/double-tempo mixing doesn't count as a pitch change.
 * Positive = pitched up (sped up), negative = pitched down (slowed down).
 */
export function pitchShiftSemitones(fromBpm: number, toBpm: number): number {
  if (!(fromBpm > 0) || !(toBpm > 0)) return 0;
  return 12 * Math.log2(foldTempoRatio(toBpm / fromBpm));
}

/**
 * The platter pitch adjustment, in percent, needed to beat-match a record at
 * `fromBpm` to `toBpm` — i.e. where the pitch fader has to sit. Octaves are
 * folded, so playing a 70 BPM record against a 140 BPM one needs 0%, not +100%.
 *
 * This is the number that decides whether a mix is *physically possible*: a
 * stock Technics only offers ±8%, so a transition needing +11% cannot be done
 * however well the keys fit.
 */
export function pitchPercent(fromBpm: number, toBpm: number): number {
  if (!(fromBpm > 0) || !(toBpm > 0)) return 0;
  return (foldTempoRatio(toBpm / fromBpm) - 1) * 100;
}

/** True when `percent` is within a turntable offering ±`range`%. */
export function withinPitchRange(percent: number, range: number): boolean {
  return Math.abs(percent) <= range + 1e-9;
}

/**
 * Fader position, in percent, that transposes a record by `semitones`.
 * Equal temperament, so +1 semitone is +5.95% — the "6% per semitone" rule of
 * thumb DJs use, stated exactly.
 */
export function percentForSemitones(semitones: number): number {
  return (Math.pow(2, semitones / 12) - 1) * 100;
}

/** Semitones a record is transposed by at `percent` on the fader. */
export function semitonesForPercent(percent: number): number {
  return 12 * Math.log2(1 + percent / 100);
}

/**
 * Restates `bpm` in the octave nearest `referenceBpm`, e.g. a 70 BPM record
 * against a 138 BPM set becomes 140.
 *
 * Once every record in a route has been folded into the *same* frame, tempo
 * becomes a single number the whole route shares, so pitch amounts can be
 * added up across several mixes instead of being recomputed pair by pair.
 * Returns null when either BPM is unusable.
 */
export function foldBpmTo(bpm: number, referenceBpm: number): number | null {
  if (!(bpm > 0) || !(referenceBpm > 0)) return null;
  return referenceBpm * foldTempoRatio(bpm / referenceBpm);
}

/**
 * Fader position, in percent, for a record whose (already folded) BPM is
 * `nominalBpm` when it has to play at `tempo`.
 */
export function pitchToTempo(nominalBpm: number, tempo: number): number {
  if (!(nominalBpm > 0) || !(tempo > 0)) return 0;
  return (tempo / nominalBpm - 1) * 100;
}

/** Semitones a record at (folded) `nominalBpm` is transposed by at `tempo`. */
export function semitonesToTempo(nominalBpm: number, tempo: number): number {
  if (!(nominalBpm > 0) || !(tempo > 0)) return 0;
  return 12 * Math.log2(tempo / nominalBpm);
}

/** An inclusive tempo window, in BPM. */
export interface TempoWindow {
  lo: number;
  hi: number;
}

/** The tempos a record with (folded) `nominalBpm` can be played at on ±`range`% decks. */
export function tempoWindow(nominalBpm: number, range: number): TempoWindow {
  return { lo: nominalBpm * (1 - range / 100), hi: nominalBpm * (1 + range / 100) };
}

/** Intersection of two tempo windows, or null when they don't overlap. */
export function intersectWindows(a: TempoWindow, b: TempoWindow): TempoWindow | null {
  const lo = Math.max(a.lo, b.lo);
  const hi = Math.min(a.hi, b.hi);
  return lo <= hi + 1e-9 ? { lo, hi } : null;
}

/** Clamps a tempo into a window. */
export function clampToWindow(tempo: number, w: TempoWindow): number {
  return Math.min(Math.max(tempo, w.lo), w.hi);
}

/** Shifts a Camelot code by a whole number of semitones (+1 semitone = +7 wheel steps). */
export function shiftCamelot(code: string, semitones: number): string {
  const m = CAMELOT_RE.exec(code);
  if (!m) return code;
  const n = Number(m[1]);
  const steps = Math.round(semitones) * 7;
  return `${wrap(n + steps)}${m[2]}`;
}

/**
 * Pitch class (0=C .. 11=B) for a root note, in every spelling it turns up in.
 *
 * Both spellings of each black key are here because sources disagree: Beatport
 * writes "Bb Minor" where this collection writes "A# minor", and they are the
 * same key. The white-key accidentals (Cb, Fb, E#, B#) are rare but legal, and
 * cost nothing to accept — a key that fails to parse loses its Camelot code,
 * which quietly drops the track out of every key filter and mixable list.
 */
const NOTE_INDEX: Record<string, number> = {
  C: 0, 'B#': 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, FB: 4,
  F: 5, 'E#': 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10,
  BB: 10, B: 11, CB: 11,
};
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Shifts the root note of a key name (e.g. "A minor") by a whole number of semitones. */
export function shiftKeyName(keyName: string, semitones: number): string {
  if (!keyName) return keyName;
  const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(keyName.trim());
  if (!m) return keyName;
  const root = m[1].toUpperCase() + (m[2] === 'b' ? 'B' : m[2]);
  const idx = NOTE_INDEX[root];
  if (idx === undefined) return keyName;
  const shifted = SHARP_NAMES[(((idx + Math.round(semitones)) % 12) + 12) % 12];
  return shifted + m[3];
}

/** Tonic pitch class (0=C .. 11=B) for a Camelot code. */
function tonicPc(n: number, letter: string): number {
  // 8A = A minor (pc 9), 8B = C major (pc 0); each +1 camelot = +7 semitones.
  const base = letter === 'A' ? 9 : 0;
  return (((base + 7 * (n - 8)) % 12) + 12) % 12;
}

/**
 * Camelot code for a musical key name, e.g. "Bb minor" -> "3A". '' when the
 * name can't be read.
 *
 * The inverse of `camelotToKeyName`, and needed because not every source
 * publishes a wheel position: Beatport's search index gives only a key name
 * ("Bb Minor"), so the code has to be derived. Going through the pitch class
 * rather than a lookup table makes it enharmonic-blind, which matters — the
 * wheel's canonical spelling of 3A is "A# minor", and a table keyed on that
 * string alone would fail to place the "Bb minor" that Beatport actually sends.
 *
 * Derivation: tonicPc inverts to n = 8 + 7·(pc − base) (mod 12), since 7 is its
 * own multiplicative inverse mod 12 (7·7 = 49 ≡ 1).
 */
export function keyNameToCamelot(keyName: string): string {
  const m = /^\s*([A-Ga-g])\s*([#b]?)\s*(.*)$/.exec(keyName || '');
  if (!m) return '';
  const root = m[1].toUpperCase() + (m[2] === 'b' ? 'B' : m[2]);
  const pc = NOTE_INDEX[root];
  if (pc === undefined) return '';

  const rest = m[3].trim().toLowerCase();
  // Anything not explicitly major is treated as minor only when it says so;
  // an unreadable mode is refused rather than guessed, since picking the wrong
  // one moves the key three places round the wheel.
  let letter: 'A' | 'B';
  if (/^maj/.test(rest)) letter = 'B';
  else if (/^(min|m$)/.test(rest) || rest === 'm') letter = 'A';
  else return '';

  const base = letter === 'A' ? 9 : 0;
  return `${wrap(8 + 7 * (pc - base))}${letter}`;
}

/**
 * The Camelot code a search term refers to, whether it is written as a code
 * ("8A") or as a key name ("A minor", "Bb minor"). '' when it is neither.
 */
export function camelotOfQuery(term: string): string {
  const s = (term || '').trim();
  if (!s) return '';
  const m = CAMELOT_RE.exec(s.toUpperCase());
  if (m) return `${Number(m[1])}${m[2]}`;
  return keyNameToCamelot(s);
}

/**
 * True when two key names mean the same key, whatever their spelling —
 * "A# minor" and "Bb minor", "C# major" and "Db major".
 *
 * Comparison goes through the Camelot code, which is spelling-independent.
 * Names that can't be parsed fall back to a plain text comparison, so an
 * unrecognised value is still equal to itself rather than being reported as a
 * change on every pass.
 */
export function sameKeyName(a: string, b: string): boolean {
  const ca = keyNameToCamelot(a);
  const cb = keyNameToCamelot(b);
  if (ca && cb) return ca === cb;
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
}

/**
 * Human label describing how `code` relates to `base`, based on the exact
 * semitone interval between their tonics and whether the mode matches.
 * Works for any pair (e.g. keys pitched to match BPM), not just the
 * canonical mixable positions — so a pitched key reports its true type.
 */
export function relation(base: string, code: string): string {
  const mb = CAMELOT_RE.exec(base);
  const mc = CAMELOT_RE.exec(code);
  if (!mb || !mc) return '';
  const pb = tonicPc(Number(mb[1]), mb[2]);
  const pc = tonicPc(Number(mc[1]), mc[2]);
  const sameMode = mb[2] === mc[2];

  // Signed semitone interval from base to code, normalised to (-5..6].
  let iv = (((pc - pb) % 12) + 12) % 12; // 0..11
  if (iv > 6) iv -= 12; // -5..6

  if (sameMode) {
    switch (iv) {
      case 0: return 'Same key';
      case -5: return '+1 energy';        // perfect fifth up
      case 5: return '-1 energy';         // perfect fifth down (fourth up)
      case 1: return '+1 energy boost';
      case -1: return '-1 energy drop';
      case 2: return '+2 energy boost';
      case -2: return '-2 energy drop';
      case 3: return '+3 energy boost';
      case -3: return '-3 energy drop';
      case 4: return '+4 energy boost';
      case -4: return '-4 energy drop';
      case 6: return '+6 energy boost';   // tritone
    }
    return 'Compatible';
  }

  // Different mode.
  if (iv === 0) return 'Same root';       // parallel major/minor
  if (iv === 3 || iv === -3) return 'Relative';
  return iv > 0 ? `+${iv} energy boost` : `${iv} energy drop`;
}

