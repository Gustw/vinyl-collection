import { Track } from './models';
import {
  pitchPercent,
  pitchShiftSemitones,
  relation,
  shiftCamelot,
  withinPitchRange,
  mixableCamelot,
} from './camelot';

/** How serious a problem with a transition is. */
export type TransitionLevel = 'good' | 'warn' | 'bad';

/** The evaluation of playing `to` straight after `from`. */
export interface Transition {
  from: Track;
  to: Track;
  /** Relationship of the keys once `to` is pitched to match `from`. */
  relation: string;
  /** Camelot code `to` actually sounds in after beat-matching. */
  effectiveCamelot: string;
  /** Platter pitch `to` needs, in percent (null when a BPM is unknown). */
  percent: number | null;
  /** Raw BPM difference, or null when a BPM is unknown. */
  bpmDelta: number | null;
  /** True when the pitch needed is within the decks' range. */
  reachable: boolean;
  /** True when the (pitched) keys are harmonically compatible. */
  harmonic: boolean;
  level: TransitionLevel;
  /** Human explanations of anything wrong, worst first. */
  issues: string[];
}

/**
 * Evaluates one transition of a set.
 *
 * The check is done on the key each record *actually sounds in* once it has
 * been pitched to match the outgoing tempo — pitching to beat-match shifts the
 * pitch of the whole record, so a pair that looks compatible on paper can drift
 * out of key in practice (and occasionally the reverse).
 */
export function evaluateTransition(from: Track, to: Track, pitchRange: number): Transition {
  const fromBpm = parseFloat(from.bpm);
  const toBpm = parseFloat(to.bpm);
  const known = !Number.isNaN(fromBpm) && fromBpm > 0 && !Number.isNaN(toBpm) && toBpm > 0;

  const percent = known ? pitchPercent(toBpm, fromBpm) : null;
  const bpmDelta = known ? toBpm - fromBpm : null;
  const reachable = percent === null || withinPitchRange(percent, pitchRange);

  // Key the incoming record ends up in after being pitched to match.
  const semis = known ? pitchShiftSemitones(toBpm, fromBpm) : 0;
  const effectiveCamelot = known ? shiftCamelot(to.camelot, semis) : to.camelot;

  const rel = from.camelot && effectiveCamelot ? relation(from.camelot, effectiveCamelot) : '';
  const harmonic = !!from.camelot && mixableCamelot(from.camelot).includes(effectiveCamelot);

  const issues: string[] = [];
  let level: TransitionLevel = 'good';

  if (!from.camelot || !to.camelot) {
    issues.push('Key unknown — this transition cannot be checked.');
    level = 'warn';
  } else if (!harmonic) {
    issues.push(`Keys clash: ${from.camelot} into ${effectiveCamelot} (${rel || 'unrelated'}).`);
    level = 'bad';
  }

  if (!known) {
    issues.push('BPM unknown — beat-matching cannot be checked.');
    if (level === 'good') level = 'warn';
  } else if (!reachable) {
    issues.push(
      `Needs ${formatPercent(percent!)} pitch — beyond the ±${pitchRange}% your decks offer.`
    );
    level = 'bad';
  } else if (Math.abs(percent!) > pitchRange * 0.75) {
    issues.push(`Needs ${formatPercent(percent!)} pitch — near the end of the fader.`);
    if (level === 'good') level = 'warn';
  }

  return {
    from,
    to,
    relation: rel,
    effectiveCamelot,
    percent,
    bpmDelta,
    reachable,
    harmonic,
    level,
    issues,
  };
}

/** Signed percentage label, e.g. "+2.4%" / "−3.1%". */
export function formatPercent(percent: number): string {
  const sign = percent >= 0 ? '+' : '−';
  return `${sign}${Math.abs(percent).toFixed(1)}%`;
}

/** Evaluates every consecutive pair in an ordered set. */
export function evaluateSet(tracks: Track[], pitchRange: number): Transition[] {
  const out: Transition[] = [];
  for (let i = 0; i < tracks.length - 1; i++) {
    out.push(evaluateTransition(tracks[i], tracks[i + 1], pitchRange));
  }
  return out;
}

