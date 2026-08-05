/**
 * Ambient types for the essentia.js core API.
 *
 * The package ships a hand-written `core_api.d.ts` but does not wire it up to
 * the individual `dist/*.es.js` files, so TypeScript would otherwise refuse the
 * dynamic `import()` in audio-analysis.ts. Only the handful of members we
 * actually call are declared — everything else stays `any`, which is honest:
 * the surface is a WASM binding, not a typed library.
 *
 * The WebAssembly runtime itself has no declaration here: it is loaded as a
 * plain script from `assets/essentia/` rather than imported (see
 * `scripts/copy-essentia.mjs` for why).
 */

declare module 'essentia.js/dist/essentia.js-core.es.js' {
  /** One key estimate from `KeyExtractor`. */
  export interface EssentiaKey {
    /** Tonic, e.g. "C#". */
    key: string;
    /** "major" | "minor". */
    scale: string;
    /** How well the chroma matched the winning profile, 0..1. */
    strength: number;
  }

  /** Output of `RhythmExtractor2013` (the vectors must be `.delete()`d). */
  export interface EssentiaRhythm {
    bpm: number;
    /** 0 (hopeless) … 5.32 (certain), for the `multifeature` method only. */
    confidence: number;
    ticks: any;
    estimates: any;
    bpmIntervals: any;
  }

  export default class Essentia {
    constructor(wasmModule: any, isDebug?: boolean);
    readonly version: string;
    arrayToVector(input: Float32Array): any;
    vectorToArray(input: any): Float32Array;
    KeyExtractor(
      audio: any,
      averageDetuningCorrection?: boolean,
      frameSize?: number,
      hopSize?: number,
      hpcpSize?: number,
      maxFrequency?: number,
      maximumSpectralPeaks?: number,
      minFrequency?: number,
      pcpThreshold?: number,
      profileType?: string,
      sampleRate?: number,
      spectralPeaksThreshold?: number,
      tuningFrequency?: number,
      weightType?: string,
      windowType?: string
    ): EssentiaKey;
    RhythmExtractor2013(
      signal: any,
      maxTempo?: number,
      method?: string,
      minTempo?: number
    ): EssentiaRhythm;
    PercivalBpmEstimator(
      signal: any,
      frameSize?: number,
      frameSizeOSS?: number,
      hopSize?: number,
      hopSizeOSS?: number,
      maxBPM?: number,
      minBPM?: number,
      sampleRate?: number
    ): { bpm: number };
    shutdown(): void;
    delete(): void;
  }
}


