/**
 * Key and tempo estimation for a recorded fragment, built on Essentia.
 *
 * The engine is essentia.js — the WebAssembly build of Essentia, the music
 * information retrieval library from the Music Technology Group at UPF. Its key
 * and tempo algorithms are the ones the published evaluations are run against,
 * which is why nothing here is home-grown DSP.
 *
 * The library alone is not enough, though. Any single estimator will now and
 * then answer confidently and wrongly, and a wrong key written into tracks.txt
 * is worse than no key at all: it silently poisons every mixable-tracks list
 * that reads it. So this module never trusts one estimate. It asks several
 * independent questions and only reports an answer when they agree:
 *
 *  - **Key** is estimated with three different chroma profiles (`edma`, tuned
 *    on electronic dance music, plus `bgate` and `temperley`) over the whole
 *    fragment, and again with `edma` over each third of it. Seven or so
 *    estimates then vote, weighted by the strength Essentia reports.
 *  - **Tempo** is estimated by `RhythmExtractor2013` in multifeature mode —
 *    which is a committee of five beat trackers and reports how much they
 *    agreed — and cross-checked against `PercivalBpmEstimator` on the whole
 *    fragment and on each half.
 *
 * Disagreement is not hidden. It lowers the confidence, sets `reliable` to
 * false and produces a plain-English warning, so the dialog can refuse to
 * pre-tick a field the analysis is not sure about.
 */

import { keyNameToCamelot } from './camelot';
import { bpmText, keyTextOf, normaliseKeyName } from './keyinfo';
import { ANALYSIS_SAMPLE_RATE, Recording } from './mic-recorder';

/** Chroma profiles to poll for the key. `edma` is the dance-music-trained one. */
const KEY_PROFILES = ['edma', 'bgate', 'temperley'] as const;

/** Shortest fragment worth analysing at all. Below this, tempo is guesswork. */
export const MIN_ANALYSIS_SECONDS = 8;

/** How long we ask for by default: long enough for the beat trackers to settle. */
export const DEFAULT_LISTEN_SECONDS = 30;

/** Below this RMS the capture is effectively silence (about -46 dBFS). */
const SILENCE_RMS = 0.005;

/** Below this RMS there is signal, but not enough to trust. */
const QUIET_RMS = 0.02;

/** Tempi outside this window are almost certainly an octave error for a DJ record. */
const SANE_BPM = { min: 60, max: 200 } as const;

/** One vote in the key election. */
export interface KeyVote {
  camelot: string;
  keyName: string;
  /** Essentia's match strength for this estimate, 0..1. */
  strength: number;
  /** How much this estimate counts (whole-fragment estimates count more). */
  weight: number;
  /** Where it came from, e.g. "edma, whole fragment". */
  label: string;
}

/** What the analysis concluded, with everything the UI needs to argue its case. */
export interface AnalysisResult {
  /** e.g. "A minor" ('' when no key could be agreed). */
  keyName: string;
  /** e.g. "8A" ('' when no key could be agreed). */
  camelot: string;
  /** e.g. "A minor (8A)" ('' when no key could be agreed). */
  keyText: string;
  /** Rounded BPM as the app stores it, e.g. "128" ('' when undecided). */
  bpm: string;
  /** The unrounded tempo, e.g. 127.6 (0 when undecided). */
  bpmExact: number;

  /** 0..1. Above ~0.7 the estimate is worth writing down. */
  keyConfidence: number;
  /** 0..1. */
  bpmConfidence: number;
  /** True when the key estimates agreed strongly enough to pre-tick the field. */
  keyReliable: boolean;
  /**
   * True when the estimators agreed about *which notes* were playing — the
   * Camelot number — even if they split over major versus minor. This is the
   * half that harmonic mixing is computed from, so it is worth reporting on its
   * own: "certainly an 8, probably 8A" is far more useful than "not sure".
   */
  keyNotesCertain: boolean;
  /** True when major-versus-minor was close, i.e. 8A vs 8B. */
  keyModeUncertain: boolean;
  /** True when the tempo estimates agreed strongly enough to pre-tick the field. */
  bpmReliable: boolean;

  /** The key that came second, when it was close, e.g. "5A" (else ''). */
  runnerUpCamelot: string;
  /** Half/double-time reading of the tempo when one is plausible (else 0). */
  altBpm: number;

  /** Plain-English caveats to show next to the numbers. */
  notes: string[];
  /** Every key estimate, for the "how did it decide?" panel. */
  votes: KeyVote[];
  /** Every tempo estimate, rounded to one decimal. */
  bpmEstimates: { label: string; bpm: number }[];

  durationSec: number;
}

/** Raised when the recording itself is unusable, before any analysis is attempted. */
export class AnalysisError extends Error {
  constructor(message: string, readonly hint = '') {
    super(message);
    this.name = 'AnalysisError';
  }
}

// --- essentia.js loading -----------------------------------------------------

type EssentiaCore = import('essentia.js/dist/essentia.js-core.es.js').default;

/**
 * Where the WebAssembly runtime is served from, relative to the app's base
 * href. `scripts/copy-essentia.mjs` puts it there; resolving against
 * `document.baseURI` is what makes it work from a GitHub Pages subdirectory as
 * well as from the root.
 */
const WASM_DIR = 'assets/essentia/';

let loading: Promise<EssentiaCore> | null = null;

function assetUrl(file: string): string {
  return new URL(WASM_DIR + file, document.baseURI).href;
}

/**
 * Loads the WASM runtime.
 *
 * It goes in as a plain <script> rather than an import because the emscripten
 * glue is a classic script that resolves its own .wasm relative to where it was
 * loaded from — bundling it would break that, and the single-file variant that
 * avoids the problem carries Node `fs`/`path` requires the bundler rejects.
 * `locateFile` pins the binary to the same folder regardless.
 */
async function loadWasm(): Promise<unknown> {
  const global = window as unknown as {
    EssentiaWASM?: (overrides: { locateFile(file: string): string }) => Promise<unknown>;
  };
  if (!global.EssentiaWASM) {
    await new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = assetUrl('essentia-wasm.web.js');
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('failed to load ' + el.src));
      document.head.appendChild(el);
    });
  }
  if (!global.EssentiaWASM) throw new Error('essentia runtime did not register itself');
  return global.EssentiaWASM({ locateFile: (file: string) => assetUrl(file) });
}

/**
 * Loads (once) and returns the Essentia instance.
 *
 * A user who never records anything never downloads any of it: both the JS API
 * and the two-megabyte WASM binary are fetched on first use.
 */
export function loadEssentia(): Promise<EssentiaCore> {
  if (!loading) {
    loading = (async () => {
      try {
        const [wasm, core] = await Promise.all([
          loadWasm(),
          import('essentia.js/dist/essentia.js-core.es.js'),
        ]);
        return new core.default(wasm);
      } catch {
        // Let a later attempt retry rather than caching the failure forever.
        loading = null;
        throw new AnalysisError(
          'The audio analysis engine could not be loaded.',
          'It is downloaded on first use — check the connection and try again.'
        );
      }
    })();
  }
  return loading;
}

/** Warms the engine up so pressing "Listen" doesn't wait on a download. */
export function preloadEssentia(): void {
  void loadEssentia().catch(() => undefined);
}

/**
 * Supplies a ready-made Essentia instance instead of loading one.
 *
 * Only the offline check script uses this: it runs the very same analysis on a
 * synthetic signal of known key and tempo under Node, where there is no
 * `document` to hang a <script> tag off. Testing the real code path rather than
 * a copy of it is the point — the parameter order of `KeyExtractor` alone has
 * fifteen positional arguments, and getting one wrong would fail silently.
 */
export function useEssentia(instance: EssentiaCore): void {
  loading = Promise.resolve(instance);
}

// --- the analysis ------------------------------------------------------------

/**
 * Estimates the key and tempo of a recorded fragment.
 *
 * @param onStatus progress lines for the UI; the whole run is a few seconds of
 *   blocking WASM work, so the user needs to see that something is happening.
 */
export async function analyseRecording(
  rec: Recording,
  onStatus?: (message: string) => void
): Promise<AnalysisResult> {
  guardRecording(rec);
  const essentia = await loadEssentia();
  const notes: string[] = [];

  if (rec.rms < QUIET_RMS) {
    notes.push(
      'The recording is quiet, which makes both estimates less reliable. ' +
        'Move the microphone closer to the speaker or turn the monitor up.'
    );
  }
  if (rec.clippedFraction > 0.005) {
    notes.push(
      'The input clipped (' +
        (rec.clippedFraction * 100).toFixed(1) +
        '% of samples at full scale). Distortion smears the harmonics the key ' +
        'estimate relies on — turn the level down and record again.'
    );
  }

  onStatus?.('Estimating key…');
  await yieldToUi();
  const key = analyseKey(essentia, rec.samples, rec.durationSec);

  onStatus?.('Estimating tempo…');
  await yieldToUi();
  const tempo = analyseTempo(essentia, rec.samples, rec.durationSec);

  notes.push(...key.notes, ...tempo.notes);

  return {
    keyName: key.keyName,
    camelot: key.camelot,
    keyText: keyTextOf(key.keyName, key.camelot),
    bpm: tempo.bpm ? bpmText(tempo.bpm) : '',
    bpmExact: tempo.bpm,
    keyConfidence: key.confidence,
    bpmConfidence: tempo.confidence,
    keyReliable: key.reliable,
    keyNotesCertain: key.notesCertain,
    keyModeUncertain: key.modeUncertain,
    bpmReliable: tempo.reliable,
    runnerUpCamelot: key.runnerUp,
    altBpm: tempo.alt,
    notes,
    votes: key.votes,
    bpmEstimates: tempo.estimates,
    durationSec: rec.durationSec,
  };
}

/** Rejects captures that cannot produce a meaningful answer. */
function guardRecording(rec: Recording): void {
  if (rec.durationSec < MIN_ANALYSIS_SECONDS) {
    throw new AnalysisError(
      `Only ${rec.durationSec.toFixed(1)}s was recorded.`,
      `Tempo detection needs at least ${MIN_ANALYSIS_SECONDS} seconds of music — ` +
        'let it run longer before stopping.'
    );
  }
  if (rec.rms < SILENCE_RMS) {
    throw new AnalysisError(
      'The recording is silent.',
      'Check that the right microphone is selected and that the record is actually playing.'
    );
  }
}

// --- key ---------------------------------------------------------------------

interface KeyOutcome {
  keyName: string;
  camelot: string;
  confidence: number;
  reliable: boolean;
  notesCertain: boolean;
  modeUncertain: boolean;
  runnerUp: string;
  votes: KeyVote[];
  notes: string[];
}

/**
 * Runs the key estimators and holds the election.
 *
 * The ensemble is deliberately varied. The three chroma profiles disagree in
 * different ways — `edma` leans towards the minor readings typical of dance
 * music, `temperley` towards classical tonality — so agreement between them is
 * real evidence rather than the same bias counted three times. The per-segment
 * runs catch the other failure mode: an intro or a breakdown sitting on one
 * chord can drag a whole-fragment estimate off to a neighbouring key. And one
 * run is restricted to the low register, because the tonic is usually the note
 * the bassline keeps returning to, which is exactly the evidence that settles
 * major-versus-minor.
 *
 * The count itself happens in two stages, because the two things a Camelot code
 * says are not equally hard to hear:
 *
 *  1. **Which notes** — the wheel number. This is what harmonic mixing is
 *     actually computed from, and estimators agree on it far more often.
 *  2. **Which mode** — the A/B letter. 8A and 8B contain identical notes, so
 *     this is a genuinely harder question and a split here is not a failure of
 *     the analysis, it is a property of the music.
 *
 * Counting them separately means an honest "the notes are certain, the mode is
 * a toss-up" instead of one muddy number that hides which half is shaky.
 */
function analyseKey(
  essentia: EssentiaCore,
  samples: Float32Array,
  durationSec: number
): KeyOutcome {
  const votes: KeyVote[] = [];
  const notes: string[] = [];

  for (const profile of KEY_PROFILES) {
    // edma is the profile trained on electronic dance music, which is what this
    // collection is, so its opinion counts for a little more than the others'.
    const weight = profile === 'edma' ? 1.2 : 1;
    const v = keyVote(essentia, samples, profile, `${profile}, whole fragment`, weight);
    if (v) votes.push(v);
  }

  // Bass-weighted run: capping the analysis at 1 kHz throws away the upper
  // harmonics that make a minor chord look like its relative major and leaves
  // the root movement, which is the best evidence for the mode.
  const low = keyVote(essentia, samples, 'edma', 'edma, low register only', 1, 1000);
  if (low) votes.push(low);

  // Segment votes only when each piece is still long enough to hold a key.
  const segments = durationSec >= 24 ? 3 : durationSec >= 16 ? 2 : 0;
  for (let i = 0; i < segments; i++) {
    const from = Math.floor((samples.length * i) / segments);
    const to = Math.floor((samples.length * (i + 1)) / segments);
    const v = keyVote(
      essentia,
      samples.subarray(from, to),
      'edma',
      `edma, part ${i + 1} of ${segments}`,
      0.6
    );
    if (v) votes.push(v);
  }

  if (!votes.length) {
    return {
      keyName: '',
      camelot: '',
      confidence: 0,
      reliable: false,
      notesCertain: false,
      modeUncertain: false,
      runnerUp: '',
      votes,
      notes: ['No key could be estimated from this recording.'],
    };
  }

  // Stage one: which notes? Score by summed weight × strength, so a confident
  // estimate outweighs a pair of hesitant ones rather than being outvoted.
  const byNumber = tally(votes, (v) => wheelNumber(v.camelot));
  const number = byNumber[0][0];
  const totalWeight = votes.reduce((n, v) => n + v.weight, 0);
  const numberAgreement = byNumber[0][1].weight / totalWeight;

  // Stage two: which mode? Only the votes that agreed about the notes get a say
  // — an estimate that heard a different scale entirely has no useful opinion
  // about whether that scale was major or minor.
  const inNumber = votes.filter((v) => wheelNumber(v.camelot) === number);
  const byCode = tally(inNumber, (v) => v.camelot);
  const [camelot, winner] = byCode[0];
  const modeAgreement = winner.weight / inNumber.reduce((n, v) => n + v.weight, 0);
  const strength = winner.strength / winner.weight;

  // 0.8 is roughly where Essentia's strength stops rising for unambiguous tonal
  // music, so it is treated as full marks rather than 1.0.
  const confidence = clamp01(
    0.4 * numberAgreement + 0.3 * modeAgreement + 0.3 * Math.min(1, strength / 0.8)
  );
  const notesCertain = numberAgreement >= 0.7 && strength >= 0.5;
  const modeUncertain = modeAgreement < 0.65;
  const reliable = notesCertain && !modeUncertain && confidence >= 0.62;

  const relative = relativeOf(camelot);
  if (!notesCertain) {
    notes.push(
      `The key estimators did not agree on the notes (only ${Math.round(numberAgreement * 100)}% ` +
        'of the weight behind the winner), so this is a guess rather than a reading. ' +
        'A longer fragment of a section with clear chords usually settles it.'
    );
  } else if (modeUncertain) {
    notes.push(
      `The notes are clear — everything points at ${number} on the wheel — but major ` +
        `versus minor was a close call between ${camelot} and ${relative}. They contain ` +
        'the same notes, so both mix identically; pick the one that matches how the ' +
        'track feels (minor = darker) or check the bassline\u2019s home note.'
    );
  }

  const runnerUp = byCode[1]?.[0] ?? (modeUncertain ? relative : '');

  return {
    keyName: winner.name,
    camelot,
    confidence,
    reliable,
    notesCertain,
    modeUncertain,
    runnerUp: runnerUp === camelot ? '' : runnerUp,
    votes,
    notes,
  };
}

/** Sums weight and strength per group, best first. */
function tally(
  votes: KeyVote[],
  keyOf: (v: KeyVote) => string
): [string, { score: number; weight: number; strength: number; name: string }][] {
  const map = new Map<string, { score: number; weight: number; strength: number; name: string }>();
  for (const v of votes) {
    const k = keyOf(v);
    const cur = map.get(k) ?? { score: 0, weight: 0, strength: 0, name: v.keyName };
    cur.score += v.weight * v.strength;
    cur.weight += v.weight;
    cur.strength += v.strength * v.weight;
    map.set(k, cur);
  }
  return [...map.entries()].sort((a, b) => b[1].score - a[1].score);
}

/** The wheel position of a Camelot code: "8A" → "8". */
function wheelNumber(camelot: string): string {
  return /^(\d{1,2})[AB]$/.exec(camelot)?.[1] ?? camelot;
}

/** The relative major/minor of a Camelot code: "8A" → "8B". */
function relativeOf(camelot: string): string {
  const m = /^(\d{1,2})([AB])$/.exec(camelot);
  return m ? `${m[1]}${m[2] === 'A' ? 'B' : 'A'}` : '';
}

/** One `KeyExtractor` run, folded into the app's key vocabulary. */
function keyVote(
  essentia: EssentiaCore,
  samples: Float32Array,
  profile: string,
  label: string,
  weight: number,
  maxFrequency = 3500
): KeyVote | null {
  const vec = essentia.arrayToVector(samples);
  try {
    const out = essentia.KeyExtractor(
      vec,
      true, // averageDetuningCorrection — vinyl is never exactly at 440 Hz
      4096,
      4096,
      12,
      maxFrequency,
      60,
      25,
      0.2,
      profile,
      ANALYSIS_SAMPLE_RATE,
      0.0001,
      440,
      'cosine',
      'hann'
    );
    const keyName = normaliseKeyName(`${out.key} ${out.scale}`);
    const camelot = keyNameToCamelot(keyName);
    if (!camelot) return null;
    const strength = Number(out.strength);
    return {
      camelot,
      keyName,
      strength: Number.isFinite(strength) ? clamp01(strength) : 0,
      weight,
      label,
    };
  } catch {
    return null;
  } finally {
    vec.delete?.();
  }
}

// --- tempo -------------------------------------------------------------------

interface TempoOutcome {
  bpm: number;
  confidence: number;
  reliable: boolean;
  alt: number;
  estimates: { label: string; bpm: number }[];
  notes: string[];
}

/**
 * Runs the tempo estimators and reconciles them.
 *
 * `RhythmExtractor2013` in multifeature mode is the reference: it runs five
 * beat trackers and its `confidence` output is how much they agreed, which is a
 * far better signal than any single tracker's certainty about itself. Percival
 * is a structurally different method (onset strength autocorrelation), so it
 * makes a genuine second opinion rather than an echo.
 *
 * Half/double-time disagreement is treated separately from real disagreement:
 * an estimator that says 87 when another says 174 has heard the same groove,
 * and folding one onto the other is correct, not a fudge.
 */
function analyseTempo(
  essentia: EssentiaCore,
  samples: Float32Array,
  durationSec: number
): TempoOutcome {
  const notes: string[] = [];
  const estimates: { label: string; bpm: number }[] = [];

  let reference = 0;
  let trackerConfidence = 0;
  const rhythmVec = essentia.arrayToVector(samples);
  try {
    const r = essentia.RhythmExtractor2013(rhythmVec, SANE_BPM.max + 8, 'multifeature', SANE_BPM.min - 20);
    reference = Number(r.bpm) || 0;
    // Documented range is 0 (hopeless) … 5.32 (certain).
    trackerConfidence = Number(r.confidence) || 0;
    if (reference) estimates.push({ label: 'Beat tracker committee', bpm: round1(reference) });
    r.ticks?.delete?.();
    r.estimates?.delete?.();
    r.bpmIntervals?.delete?.();
  } catch {
    /* fall through to the Percival estimates */
  } finally {
    rhythmVec.delete?.();
  }

  const percival = (from: number, to: number, label: string) => {
    const slice = samples.subarray(from, to);
    const vec = essentia.arrayToVector(slice);
    try {
      const bpm = Number(essentia.PercivalBpmEstimator(vec).bpm) || 0;
      if (bpm) estimates.push({ label, bpm: round1(bpm) });
      return bpm;
    } catch {
      return 0;
    } finally {
      vec.delete?.();
    }
  };

  const cross: number[] = [];
  const whole = percival(0, samples.length, 'Onset autocorrelation');
  if (whole) cross.push(whole);
  if (durationSec >= 20) {
    const mid = Math.floor(samples.length / 2);
    const a = percival(0, mid, 'Onset autocorrelation, first half');
    const b = percival(mid, samples.length, 'Onset autocorrelation, second half');
    if (a) cross.push(a);
    if (b) cross.push(b);
  }

  if (!reference) {
    // No beat tracker answer: fall back to the median Percival reading, but say so.
    if (!cross.length) {
      return {
        bpm: 0,
        confidence: 0,
        reliable: false,
        alt: 0,
        estimates,
        notes: ['No tempo could be found — the fragment may have no steady beat.'],
      };
    }
    reference = median(cross);
    notes.push(
      'The beat tracker found no stable pulse, so the tempo comes from a weaker ' +
        'method. Check it against the deck before saving.'
    );
  }

  // Fold each cross-check onto the reference's octave before comparing, so a
  // half-time reading counts as agreement about the groove.
  let agreeing = 0;
  let octaveClash = false;
  for (const c of cross) {
    const folded = foldToOctaveOf(c, reference);
    if (Math.abs(folded - reference) / reference <= 0.02) {
      agreeing++;
      if (Math.abs(c - reference) / reference > 0.02) octaveClash = true;
    }
  }
  const agreement = cross.length ? agreeing / cross.length : 0;

  let bpm = reference;
  // Nudge onto the cross-checks' consensus when they agree with each other and
  // sit a hair away — the tracker's own resolution is coarser than Percival's.
  if (agreeing >= 2) {
    const folded = cross.map((c) => foldToOctaveOf(c, reference));
    bpm = (reference + median(folded)) / 2;
  }

  const alt = alternateOctave(bpm);
  if (bpm < SANE_BPM.min || bpm > SANE_BPM.max) {
    notes.push(
      `${round1(bpm)} BPM is outside the usual range for a record${
        alt ? `, so ${round1(alt)} may be the reading you want` : ''
      }.`
    );
  } else if (octaveClash) {
    notes.push(
      'The estimators disagreed by an octave (half/double time). ' +
        `${round1(bpm)} is the more likely reading, but ${round1(alt)} is the same groove counted differently.`
    );
  }

  const trackerScore = Math.min(1, trackerConfidence / 3.5); // ≥3.5 is Essentia's "high"
  const confidence = clamp01(0.6 * trackerScore + 0.4 * agreement);
  const reliable =
    trackerConfidence >= 2 &&
    agreement >= 0.6 &&
    confidence >= 0.6 &&
    bpm >= SANE_BPM.min &&
    bpm <= SANE_BPM.max;

  if (!reliable && !notes.length) {
    notes.push(
      'The tempo estimate is not solid — a longer fragment of a steady section ' +
        '(no intro, no breakdown) usually fixes this.'
    );
  }

  return { bpm: snap(bpm), confidence, reliable, alt, estimates, notes };
}

/** Doubles or halves `bpm` until it is nearest to `reference`. */
function foldToOctaveOf(bpm: number, reference: number): number {
  let v = bpm;
  while (v < reference / 1.4) v *= 2;
  while (v > reference * 1.4) v /= 2;
  return v;
}

/** The half- or double-time reading, when it lands somewhere plausible (else 0). */
function alternateOctave(bpm: number): number {
  const half = bpm / 2;
  const double = bpm * 2;
  if (bpm > 150 && half >= SANE_BPM.min) return snap(half);
  if (bpm < 100 && double <= SANE_BPM.max) return snap(double);
  return 0;
}

/**
 * Pulls a tempo onto a whole number when it is within a rounding error of one.
 *
 * Almost every record made to a click sits on an integer BPM; reporting 127.98
 * where the pressing says 128 costs the user a moment of doubt for no gain.
 */
function snap(bpm: number): number {
  const near = Math.round(bpm);
  return Math.abs(bpm - near) <= 0.15 ? near : round1(bpm);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/**
 * Lets the browser paint before the next block of WASM work.
 *
 * Essentia runs synchronously on the main thread, and a thirty-second fragment
 * takes it a second or two per stage. Without this the "Estimating key…" line
 * would only appear after the key had already been estimated.
 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}














