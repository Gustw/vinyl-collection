import { Track, positionSide, sameRecord } from './models';
import {
  clampToWindow,
  foldBpmTo,
  intersectWindows,
  pitchToTempo,
  semitonesToTempo,
  relation,
  shiftCamelot,
  tempoWindow,
  withinPitchRange,
  mixableCamelot,
} from './camelot';

/**
 * How serious a problem with a transition is.
 *
 * 'bad' is reserved for mixes that *cannot be performed*: either the tempos are
 * further apart than the pitch faders can close, or both cuts live on the same
 * disc and so can't be on two decks at once. Everything else, clashing keys
 * included, is a 'warn': a thing to know about, not a thing the decks refuse.
 */
export type TransitionLevel = 'good' | 'warn' | 'bad';

/** The evaluation of playing `to` straight after `from`. */
export interface Transition {
  from: Track;
  to: Track;
  /** Relationship of the keys as both records actually sound during the blend. */
  relation: string;
  /** Camelot code `to` actually sounds in while it is being mixed in. */
  effectiveCamelot: string;
  /** Camelot code `from` actually sounds in while it is being mixed out. */
  fromCamelot: string;
  /** Platter pitch `to` needs, in percent (null when a BPM is unknown). */
  percent: number | null;
  /** Platter pitch `from` is sitting at during the blend, in percent. */
  fromPercent: number | null;
  /** The tempo both records run at during the blend, in BPM (null if unknown). */
  mixTempo: number | null;
  /** BPM difference between the two records, octaves folded away. */
  bpmDelta: number | null;
  /** True when the pitch needed by *both* records is within the decks' range. */
  reachable: boolean;
  /** True when both cuts are on the same physical disc, so no blend is possible. */
  sameRecord: boolean;
  /** True when the (pitched) keys are harmonically compatible. */
  harmonic: boolean;
  level: TransitionLevel;
  /** Human explanations of anything wrong, blocking problems first. */
  issues: string[];
}

/** How a transition sits in tempo: which BPMs apply, and where the set is running. */
export interface TempoContext {
  /** The outgoing record's BPM, folded into the set's octave (null if unknown). */
  fromBpm: number | null;
  /** The incoming record's BPM, folded into the set's octave (null if unknown). */
  toBpm: number | null;
  /** The tempo the blend happens at (null if unknown). */
  mixTempo: number | null;
}

/**
 * Evaluates one transition, given the tempo the blend actually happens at.
 *
 * The check is done on the key each record *sounds in at that tempo*, not its
 * printed key: pitching to beat-match transposes the whole record, so a pair
 * that looks compatible on paper can drift out of key in practice. Because the
 * outgoing record may itself already be pitched — it was beat-matched into the
 * record before it — *both* sides are transposed here, and *both* faders have
 * to be within the decks' range for the mix to be possible at all.
 */
export function evaluateTransitionAt(
  from: Track,
  to: Track,
  ctx: TempoContext,
  pitchRange: number
): Transition {
  const { fromBpm, toBpm, mixTempo } = ctx;
  const known = fromBpm !== null && toBpm !== null && mixTempo !== null;
  /** Both BPMs are known, yet no tempo exists that both decks can hold. */
  const impossible = fromBpm !== null && toBpm !== null && mixTempo === null;

  const fromPercent = known ? pitchToTempo(fromBpm!, mixTempo!) : null;
  const percent = known ? pitchToTempo(toBpm!, mixTempo!) : null;
  const bpmDelta = fromBpm !== null && toBpm !== null ? toBpm - fromBpm : null;

  const reachable =
    !impossible &&
    (!known ||
      (withinPitchRange(fromPercent!, pitchRange) && withinPitchRange(percent!, pitchRange)));

  // The keys the two records end up in once pitched to the blend tempo.
  const fromCamelot = known
    ? shiftCamelot(from.camelot, semitonesToTempo(fromBpm!, mixTempo!))
    : from.camelot;
  const effectiveCamelot = known
    ? shiftCamelot(to.camelot, semitonesToTempo(toBpm!, mixTempo!))
    : to.camelot;

  const rel = fromCamelot && effectiveCamelot ? relation(fromCamelot, effectiveCamelot) : '';
  const harmonic = !!fromCamelot && mixableCamelot(fromCamelot).includes(effectiveCamelot);

  const issues: string[] = [];
  let level: TransitionLevel = 'good';
  const warn = () => {
    if (level === 'good') level = 'warn';
  };

  // Before anything musical: one disc cannot be on two decks at once, so
  // consecutive cuts from the same record can't be blended however well their
  // keys and tempos fit. Easy to miss when planning from a screen — the two
  // cuts look like two separate tracks — and impossible to miss on the night.
  const onSameRecord = sameRecord(from, to);
  if (onSameRecord) {
    issues.push(sameRecordIssue(from, to));
    level = 'bad';
  }

  // Tempo next, because it is the only other thing here that can make a mix
  // outright impossible: no amount of taste gets a record past the end of its
  // pitch fader.
  if (!known) {
    if (impossible) {
      issues.push(
        `Tempos are too far apart: ${fromBpm!.toFixed(0)} and ${toBpm!.toFixed(0)} BPM ` +
          `can't meet within ±${pitchRange}%.`
      );
      level = 'bad';
    } else {
      issues.push('BPM unknown — beat-matching cannot be checked.');
      warn();
    }
  } else {
    // Whichever deck is working hardest decides whether this is playable.
    const worst = Math.abs(percent!) >= Math.abs(fromPercent!) ? percent! : fromPercent!;
    if (!reachable) {
      issues.push(
        `Needs ${formatPercent(worst)} pitch to hold ${mixTempo!.toFixed(1)} BPM — beyond ` +
          `the ±${pitchRange}% your decks offer.`
      );
      level = 'bad';
    } else if (Math.abs(worst) > pitchRange * 0.75) {
      issues.push(`Needs ${formatPercent(worst)} pitch — near the end of the fader.`);
      warn();
    }
  }

  // Keys are only ever a warning. A clash is a musical judgement, not a
  // physical limit: plenty of them work over a percussive intro, on a quick
  // cut, or with the offending element EQ'd out — so it is flagged for the
  // ear to settle, never presented as a mix that cannot happen.
  if (!from.camelot || !to.camelot) {
    issues.push('Key unknown — this transition cannot be checked.');
    warn();
  } else if (!harmonic) {
    issues.push(`Keys clash: ${fromCamelot} into ${effectiveCamelot} (${rel || 'unrelated'}).`);
    warn();
  }

  return {
    from,
    to,
    relation: rel,
    effectiveCamelot,
    fromCamelot,
    percent,
    fromPercent,
    mixTempo,
    bpmDelta,
    reachable,
    sameRecord: onSameRecord,
    harmonic,
    level,
    issues,
  };
}

/**
 * Explains a same-record collision, naming the sides when both are known —
 * "both on side A" reads differently to "sides A and B", which at least tells
 * you the record would also have to be flipped.
 */
function sameRecordIssue(from: Track, to: Track): string {
  const a = positionSide(from.position);
  const b = positionSide(to.position);
  let where = '';
  if (a && b) where = a === b ? ` (both on side ${a})` : ` (sides ${a} and ${b})`;
  return (
    `Both cuts are on the same record${where} — one disc can't be on two decks, ` +
    `so these can't be blended; you'd have to stop and re-cue.`
  );
}

/** Signed percentage label, e.g. "+2.4%" / "−3.1%". */
export function formatPercent(percent: number): string {
  const sign = percent >= 0 ? '+' : '−';
  return `${sign}${Math.abs(percent).toFixed(1)}%`;
}

/**
 * Evaluates every consecutive pair in an ordered set.
 *
 * The set is treated as one continuous tempo rather than a series of unrelated
 * pairs: every BPM is restated in the first known record's octave, and each
 * blend is placed at the tempo that splits the pitching between the two decks,
 * pulled into the window both of them can physically reach. A record therefore
 * comes in already pitched, is ridden to the next blend tempo, and is judged on
 * the key it sounds in at each point — which is what actually happens on the
 * night, and what makes a long climb in tempo run out of fader eventually.
 */
export function evaluateSet(tracks: Track[], pitchRange: number): Transition[] {
  const raw = tracks.map((t) => parseFloat(t.bpm));
  const first = raw.find((b) => b > 0) ?? null;
  const bpms = raw.map((b) => (first !== null && b > 0 ? foldBpmTo(b, first) : null));

  const out: Transition[] = [];
  for (let i = 0; i < tracks.length - 1; i++) {
    const a = bpms[i];
    const b = bpms[i + 1];
    let mixTempo: number | null;
    if (a !== null && b !== null) {
      const both = intersectWindows(tempoWindow(a, pitchRange), tempoWindow(b, pitchRange));
      mixTempo = both ? clampToWindow(Math.sqrt(a * b), both) : null;
    } else {
      mixTempo = a ?? b ?? null;
    }
    out.push(
      evaluateTransitionAt(tracks[i], tracks[i + 1], { fromBpm: a, toBpm: b, mixTempo }, pitchRange)
    );
  }
  return out;
}

