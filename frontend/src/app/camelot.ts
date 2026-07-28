/**
 * Harmonic mixing helpers based on the Camelot wheel.
 * Codes look like "8A" (minor) / "8B" (major), numbers 1..12.
 */

const CAMELOT_RE = /^(\d{1,2})([AB])$/;

function wrap(n: number): number {
  return ((n - 1 + 12) % 12) + 1;
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

/** Shifts a Camelot code by a whole number of semitones (+1 semitone = +7 wheel steps). */
export function shiftCamelot(code: string, semitones: number): string {
  const m = CAMELOT_RE.exec(code);
  if (!m) return code;
  const n = Number(m[1]);
  const steps = Math.round(semitones) * 7;
  return `${wrap(n + steps)}${m[2]}`;
}

const NOTE_INDEX: Record<string, number> = {
  C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5, 'F#': 6,
  GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11,
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

