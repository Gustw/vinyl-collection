/**
 * Capturing a fragment of music from the device microphone, in a form that is
 * actually analysable.
 *
 * Two decisions here matter more than everything else in this file:
 *
 *  - **Every browser "voice" enhancement is switched off.** Echo cancellation,
 *    noise suppression and automatic gain control are tuned for speech: they
 *    duck steady rhythmic content, punch holes in the spectrum and ride the
 *    level. All three wreck tempo and key estimation. A microphone recording
 *    with AGC on will happily report a confident, wrong answer, which is the
 *    one outcome we cannot have.
 *  - **We keep raw float PCM rather than a MediaRecorder blob.** Opus at the
 *    default bitrate smears the high harmonics the chroma analysis leans on,
 *    and decoding it back costs more than just keeping the samples.
 *
 * The result is delivered at exactly 44.1 kHz, mono, because that is the rate
 * Essentia's rhythm extractor assumes and it has no parameter to be told
 * otherwise.
 */

/** The rate every downstream analysis step is written against. */
export const ANALYSIS_SAMPLE_RATE = 44100;

/** A finished capture, ready for analysis. */
export interface Recording {
  /** Mono samples at {@link ANALYSIS_SAMPLE_RATE}, -1..1. */
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
  /** Loudest absolute sample seen, 0..1+ (above 1 means the input clipped). */
  peak: number;
  /** Root-mean-square level over the whole capture, 0..1. */
  rms: number;
  /** Fraction of samples at or beyond full scale, 0..1. */
  clippedFraction: number;
}

/** Live level readings for the meter, emitted a few times a second. */
export interface LevelUpdate {
  /** Short-term RMS, 0..1. */
  rms: number;
  /** Short-term peak, 0..1. */
  peak: number;
  /** Seconds captured so far. */
  elapsed: number;
}

/** Something that went wrong that the user can act on. */
export class MicError extends Error {
  constructor(message: string, readonly hint = '') {
    super(message);
    this.name = 'MicError';
  }
}

/**
 * An AudioWorklet that ships every block of input samples to the main thread.
 *
 * It is compiled from a string rather than a file so the app keeps working
 * from any base href (GitHub Pages serves this project from a subdirectory)
 * without an extra asset to forget to copy.
 */
const CAPTURE_WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    // A disconnected or not-yet-flowing input hands us nothing; staying alive
    // (returning true) lets capture resume once samples arrive.
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

/** True when this browser can record at all (http:// pages other than localhost cannot). */
export function micSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioContext !== 'undefined'
  );
}

/**
 * Records mono PCM from the default input until {@link stop} is called.
 *
 * One recorder handles one capture: call {@link start}, then exactly one of
 * {@link stop} or {@link cancel}. Both release the microphone, so the browser's
 * recording indicator never outlives the dialog that opened it.
 */
export class MicRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private chunks: Float32Array[] = [];
  private frames = 0;
  private stopped = false;

  /** Rate the samples were captured at (before any resampling). */
  private captureRate = ANALYSIS_SAMPLE_RATE;

  /**
   * Opens the microphone and begins buffering.
   *
   * @param onLevel called roughly every audio block with the current level, so
   *   the caller can show a meter — a silent meter is the user's only clue that
   *   they picked the wrong input before wasting thirty seconds.
   */
  async start(onLevel?: (level: LevelUpdate) => void): Promise<void> {
    if (!micSupported()) {
      throw new MicError(
        'This browser cannot record audio.',
        'Microphone capture needs a secure page — open the app over https:// (or on localhost).'
      );
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // The whole point: hand us the room, not a cleaned-up voice.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
    } catch (e: unknown) {
      throw micErrorFor(e);
    }

    // Asking for 44.1 kHz up front usually avoids resampling entirely; when the
    // browser refuses (Safari pins the hardware rate) `finish()` resamples.
    this.ctx = new AudioContext({ sampleRate: ANALYSIS_SAMPLE_RATE });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.captureRate = this.ctx.sampleRate;

    const source = this.ctx.createMediaStreamSource(this.stream);

    // An explicit mono gain stage: a stereo interface would otherwise give the
    // worklet only its left channel, which on a badly wired deck can be silent.
    const mono = this.ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    mono.channelInterpretation = 'speakers';
    source.connect(mono);

    const sink = await this.makeCapture(mono, onLevel);
    this.nodes = [source, mono, ...sink];
  }

  /** Seconds captured so far. */
  get elapsed(): number {
    return this.frames / this.captureRate;
  }

  /** Stops recording and returns the capture at the analysis sample rate. */
  async stop(): Promise<Recording> {
    if (this.stopped) throw new MicError('This recording was already finished.');
    this.stopped = true;
    const rate = this.captureRate;
    const chunks = this.chunks;
    this.chunks = [];
    this.release();
    return finish(chunks, this.frames, rate);
  }

  /** Abandons the recording and releases the microphone. */
  cancel(): void {
    this.stopped = true;
    this.chunks = [];
    this.release();
  }

  /**
   * Wires up sample capture, preferring an AudioWorklet and falling back to a
   * ScriptProcessor. The fallback is deprecated but still universally
   * implemented, and it is the only option on browsers that block worklets
   * built from blob URLs.
   */
  private async makeCapture(
    from: AudioNode,
    onLevel?: (level: LevelUpdate) => void
  ): Promise<AudioNode[]> {
    const ctx = this.ctx!;
    const take = (block: Float32Array) => {
      if (this.stopped) return;
      this.chunks.push(block);
      this.frames += block.length;
      if (onLevel) onLevel(levelOf(block, this.elapsed));
    };

    try {
      const url = URL.createObjectURL(
        new Blob([CAPTURE_WORKLET], { type: 'application/javascript' })
      );
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
      });
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => take(ev.data);
      from.connect(node);
      return [node];
    } catch {
      // ScriptProcessor only runs while it is connected to the destination, so
      // it goes through a muted gain node — the user must not hear themselves.
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (ev) => take(new Float32Array(ev.inputBuffer.getChannelData(0)));
      const mute = ctx.createGain();
      mute.gain.value = 0;
      from.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      return [proc, mute];
    }
  }

  private release(): void {
    for (const n of this.nodes) {
      try {
        // A worklet's port keeps a reference to this recorder until it is shut.
        const port = (n as Partial<AudioWorkletNode>).port;
        if (port) {
          port.onmessage = null;
          port.close();
        }
        (n as Partial<ScriptProcessorNode>).onaudioprocess = null;
        n.disconnect();
      } catch {
        /* already torn down */
      }
    }
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}

/** Short-term level of one block, for the meter. */
function levelOf(block: Float32Array, elapsed: number): LevelUpdate {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < block.length; i++) {
    const v = block[i];
    sum += v * v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return { rms: Math.sqrt(sum / Math.max(1, block.length)), peak, elapsed };
}

/** Joins the captured blocks, resamples to 44.1 kHz and measures the result. */
async function finish(
  chunks: Float32Array[],
  frames: number,
  rate: number
): Promise<Recording> {
  if (!frames) {
    throw new MicError(
      'No audio reached the app.',
      'Check that the right input is selected and that the browser has microphone access.'
    );
  }

  let samples = new Float32Array(frames);
  let at = 0;
  for (const c of chunks) {
    samples.set(c, at);
    at += c.length;
  }

  if (rate !== ANALYSIS_SAMPLE_RATE) samples = await resample(samples, rate);

  let sum = 0;
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sum += v * v;
    const a = v < 0 ? -v : v;
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

/**
 * Resamples to 44.1 kHz through an OfflineAudioContext.
 *
 * Naive sample dropping would shift the detected tempo by the rate ratio (a
 * 48 kHz capture read as 44.1 kHz reports 128 BPM as 139), so this goes through
 * the browser's own band-limited resampler rather than doing it by hand.
 */
async function resample(samples: Float32Array, from: number): Promise<Float32Array> {
  const length = Math.max(1, Math.round((samples.length * ANALYSIS_SAMPLE_RATE) / from));
  const offline = new OfflineAudioContext(1, length, ANALYSIS_SAMPLE_RATE);
  // createBuffer takes its own rate, so the source node does the conversion.
  const buffer = offline.createBuffer(1, samples.length, from);
  buffer.copyToChannel(samples, 0);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}

/** Turns a getUserMedia rejection into something worth showing a user. */
function micErrorFor(e: unknown): MicError {
  const name = (e as { name?: string })?.name || '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new MicError(
        'Microphone access was denied.',
        'Allow the microphone for this site in the browser address bar, then try again.'
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new MicError(
        'No microphone was found.',
        'Connect an input device and reload the page.'
      );
    case 'NotReadableError':
      return new MicError(
        'The microphone is in use by another application.',
        'Close whatever else is recording and try again.'
      );
    default:
      return new MicError('Could not open the microphone: ' + String(e));
  }
}



