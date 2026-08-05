/**
 * Offline sanity check for the microphone key/BPM analysis.
 *
 * Run with `npm run check:analysis`.
 *
 * The dialog will happily show whatever the analysis returns, so the analysis
 * has to be right — and the one thing that could break it invisibly is the
 * fifteen positional arguments `KeyExtractor` takes, where swapping two numbers
 * yields a confident, wrong answer rather than an error. This feeds the real
 * `analyseRecording()` a synthetic recording whose key and tempo are known by
 * construction, and fails loudly if the answer drifts.
 *
 * It also simulates the awkward cases the UI has to survive: a fragment that is
 * far too short, and one that is silent.
 */

import { createRequire } from 'node:module';
import {
  AnalysisError,
  analyseRecording,
  useEssentia,
} from '../src/app/audio-analysis';
import { ANALYSIS_SAMPLE_RATE, Recording } from '../src/app/mic-recorder';

const require = createRequire(import.meta.url);

/** Semitone offsets from A of the chords in an A-minor progression. */
const PROGRESSION: { name: string; notes: number[] }[] = [
  { name: 'Am', notes: [0, 3, 7] }, // A C E
  { name: 'F', notes: [-4, 0, 3] }, // F A C
  { name: 'C', notes: [3, 7, 10] }, // C E G
  { name: 'G', notes: [-2, 2, 5] }, // G B D
];

const TEST_BPM = 128;
const TEST_SECONDS = 32;

/** Frequency of a note that many semitones from A2 (110 Hz). */
function freq(semitones: number): number {
  return 110 * Math.pow(2, semitones / 12);
}

/**
 * Builds a fragment of "music": a four-to-the-floor kick at a known tempo over
 * an A-minor chord progression, plus a little noise so the onset detectors have
 * something realistic to chew on.
 */
function synthesise(bpm: number, seconds: number): Float32Array {
  const rate = ANALYSIS_SAMPLE_RATE;
  const n = Math.floor(seconds * rate);
  const out = new Float32Array(n);
  const beat = 60 / bpm;
  const barsPerChord = 2;
  const chordLen = beat * 4 * barsPerChord;

  for (let i = 0; i < n; i++) {
    const t = i / rate;

    // Harmonic bed: three notes of the current chord, with a couple of partials
    // each so the chroma has real spectral content to work from.
    const chord = PROGRESSION[Math.floor(t / chordLen) % PROGRESSION.length];
    let sample = 0;
    for (const note of chord.notes) {
      const f = freq(note + 12);
      sample += 0.16 * Math.sin(2 * Math.PI * f * t);
      sample += 0.08 * Math.sin(2 * Math.PI * f * 2 * t);
      sample += 0.04 * Math.sin(2 * Math.PI * f * 3 * t);
    }

    // Kick on every beat: a decaying low sine, which is what the beat trackers
    // key off.
    const intoBeat = t % beat;
    if (intoBeat < 0.15) {
      const env = Math.exp(-intoBeat * 28);
      sample += 0.75 * env * Math.sin(2 * Math.PI * 55 * t);
    }
    // Hat on the offbeat, for a second onset stream.
    const intoOff = (t + beat / 2) % beat;
    if (intoOff < 0.03) {
      sample += 0.12 * Math.exp(-intoOff * 180) * (Math.random() * 2 - 1);
    }

    out[i] = Math.max(-1, Math.min(1, sample * 0.5));
  }
  return out;
}

/** Wraps samples in the shape `analyseRecording` expects from the recorder. */
function asRecording(samples: Float32Array): Recording {
  let sum = 0;
  let peak = 0;
  let clipped = 0;
  for (const v of samples) {
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
  }
  return {
    samples,
    sampleRate: ANALYSIS_SAMPLE_RATE,
    durationSec: samples.length / ANALYSIS_SAMPLE_RATE,
    peak,
    rms: Math.sqrt(sum / Math.max(1, samples.length)),
    clippedFraction: clipped / Math.max(1, samples.length),
  };
}

/** Doubles/halves `bpm` until it is nearest `reference`, as the analysis does. */
function fold(bpm: number, reference: number): number {
  let v = bpm;
  while (v < reference / 1.4) v *= 2;
  while (v > reference * 1.4) v /= 2;
  return v;
}

let failures = 0;

function check(ok: boolean, what: string, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const pkg = require('essentia.js');
  const Essentia = pkg.Essentia?.default ?? pkg.Essentia;
  const wasm = pkg.EssentiaWASM?.EssentiaWASM ?? pkg.EssentiaWASM;
  const essentia = new Essentia(wasm);
  useEssentia(essentia);
  console.log(`essentia ${essentia.version}\n`);

  // --- a fragment whose key and tempo are known by construction --------------
  console.log(`Synthesising ${TEST_SECONDS}s of A minor at ${TEST_BPM} BPM…`);
  const result = await analyseRecording(asRecording(synthesise(TEST_BPM, TEST_SECONDS)));
  console.log(
    `  key ${result.camelot || '—'} (${result.keyName || '—'}) ` +
      `@ ${Math.round(result.keyConfidence * 100)}%, ` +
      `bpm ${result.bpmExact || '—'} @ ${Math.round(result.bpmConfidence * 100)}%`
  );
  for (const n of result.notes) console.log(`  note: ${n}`);

  // A minor is 8A and C major is 8B: they contain exactly the same notes, so a
  // chroma method may legitimately land on either — and a synthetic loop with
  // no bassline gives it nothing to break the tie with. The wheel *number* is
  // what has to be right, because that is what the mixable-tracks list is
  // computed from; the mode only has to be reported honestly.
  const number = /^(\d{1,2})[AB]$/.exec(result.camelot)?.[1];
  check(number === '8', 'key lands on the right Camelot number', `got ${result.camelot || 'nothing'}`);
  check(result.keyNotesCertain, 'the notes are reported as certain');
  check(
    result.keyReliable || result.keyModeUncertain,
    'an unreliable key says which half it is unsure about',
    result.keyReliable ? 'reported reliable outright' : 'flagged the major/minor split'
  );
  check(
    !result.keyModeUncertain || result.notes.some((n) => n.includes('major')),
    'a contested mode produces a warning the user can act on'
  );

  const folded = result.bpmExact ? fold(result.bpmExact, TEST_BPM) : 0;
  const drift = folded ? Math.abs(folded - TEST_BPM) / TEST_BPM : 1;
  check(drift <= 0.02, 'tempo is within 2% of the true tempo', `got ${result.bpmExact} BPM`);
  check(result.bpmReliable, 'tempo is reported as reliable');
  check(
    result.votes.length >= 5 && result.bpmEstimates.length >= 3,
    'the ensemble actually ran',
    `${result.votes.length} key votes, ${result.bpmEstimates.length} tempo estimates`
  );

  // --- a second tempo, to prove nothing is hard-coded ------------------------
  const slow = await analyseRecording(asRecording(synthesise(92, 30)));
  const slowDrift = slow.bpmExact ? Math.abs(fold(slow.bpmExact, 92) - 92) / 92 : 1;
  check(slowDrift <= 0.02, 'a 92 BPM fragment is read as 92 BPM', `got ${slow.bpmExact} BPM`);

  // --- the failure modes the dialog has to handle ---------------------------
  await expectError(
    asRecording(synthesise(TEST_BPM, 4)),
    'a too-short fragment is refused rather than guessed at'
  );
  await expectError(
    asRecording(new Float32Array(ANALYSIS_SAMPLE_RATE * 20)),
    'a silent fragment is refused rather than guessed at'
  );

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

async function expectError(rec: Recording, what: string): Promise<void> {
  try {
    await analyseRecording(rec);
    check(false, what, 'it returned an answer');
  } catch (e) {
    check(e instanceof AnalysisError, what, e instanceof Error ? e.message : String(e));
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});


