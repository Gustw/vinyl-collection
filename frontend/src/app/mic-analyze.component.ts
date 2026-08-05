import { Component, OnDestroy, computed, input, output, signal } from '@angular/core';
import { CAMELOT_CODES, camelotClass, camelotToKeyName } from './camelot';
import { Track } from './models';
import {
  AnalysisError,
  AnalysisResult,
  DEFAULT_LISTEN_SECONDS,
  MIN_ANALYSIS_SECONDS,
  analyseRecording,
  preloadEssentia,
} from './audio-analysis';
import { MicError, MicRecorder, Recording, micSupported } from './mic-recorder';

/**
 * What the user agreed to write to the track. A `null` field means "leave this
 * one exactly as it was" — the analysis is allowed to be sure about the tempo
 * and unsure about the key, and the user is allowed to accept only the half
 * that convinced them.
 */
export interface AnalysisApply {
  camelot: string | null;
  bpm: string | null;
}

type Stage = 'idle' | 'recording' | 'analysing' | 'result' | 'error';

/** How long to listen for, in seconds. Longer is more accurate, so 30 is the default. */
const LENGTHS = [20, 30, 45, 60];

/**
 * "Play me a bit of the record and I'll tell you the key and tempo."
 *
 * The dialog deliberately never writes anything by itself. It records, it
 * analyses, and then it *proposes* — with its own confidence on display and
 * every caveat spelled out — leaving the last word with the person who can
 * actually hear the record. Fields the analysis is not confident about arrive
 * un-ticked, so accepting the default is always the cautious choice.
 */
@Component({
  selector: 'app-mic-analyze',
  standalone: true,
  template: `
    <div class="modal-backdrop" (click)="tryClose()">
      <div class="modal mic" (click)="$event.stopPropagation()">
        <div class="modal-head">
          <h2>🎤 Detect key &amp; BPM by listening</h2>
          <span class="spacer"></span>
          <button class="btn" [disabled]="stage() === 'analysing'" (click)="tryClose()">✕</button>
        </div>

        <div class="modal-body mic-body">
          @if (track(); as t) {
            <div class="mic-track">
              <b>{{ t.title }}</b> — {{ t.artist }}
              <span class="muted">
                (currently {{ t.keyText || 'no key' }}, {{ t.bpm ? t.bpm + ' BPM' : 'no BPM' }})
              </span>
            </div>
          }

          @switch (stage()) {
            @case ('idle') {
              @if (!supported) {
                <div class="mic-note err">
                  This browser can't record audio. Microphone capture needs a secure
                  page — open the app over <b>https://</b> (or on localhost).
                </div>
              } @else {
                <ol class="mic-steps">
                  <li>Drop the needle on a <b>steady part</b> of the track — past the intro, not on a breakdown.</li>
                  <li>Set the <b>pitch fader to zero</b>, otherwise you'll be recording the pitched tempo and key.</li>
                  <li>Play it loud enough and clear of chatter; point the microphone at the monitor.</li>
                </ol>
                <div class="mic-len">
                  <label>Listen for</label>
                  @for (n of lengths; track n) {
                    <span
                      class="chip"
                      [class.active]="n === seconds()"
                      (click)="seconds.set(n)"
                    >{{ n }}s</span>
                  }
                  <span class="muted">Longer fragments give a noticeably steadier answer.</span>
                </div>
                <div class="mic-actions">
                  <button class="btn primary" (click)="start()">● Start listening</button>
                  <button class="btn" (click)="closed.emit()">Cancel</button>
                </div>
              }
            }

            @case ('recording') {
              <div class="mic-live">
                <div class="mic-count">{{ remaining() }}s</div>
                <div class="mic-meter" [class.hot]="peak() > 0.95" [class.low]="rms() < 0.02">
                  <div class="mic-meter-fill" [style.width.%]="meterWidth()"></div>
                </div>
                <div class="muted">
                  @if (rms() < 0.005) {
                    Nothing is reaching the microphone — check the input and the volume.
                  } @else if (rms() < 0.02) {
                    Very quiet. Turn it up or move closer, or the estimate will be poor.
                  } @else if (peak() > 0.98) {
                    Too loud — the input is clipping, which ruins the key estimate.
                  } @else {
                    Good level. Listening…
                  }
                </div>
                <div class="mic-progress"><div class="mic-progress-fill" [style.width.%]="progress()"></div></div>
                <div class="mic-actions">
                  <button class="btn" [disabled]="elapsed() < minSeconds" (click)="stop()">
                    ■ Stop and analyse
                  </button>
                  <button class="btn" (click)="cancel()">Cancel</button>
                </div>
              </div>
            }

            @case ('analysing') {
              <div class="mic-live">
                <div class="mic-count">⟳</div>
                <div>{{ status() }}</div>
                <div class="muted">Cross-checking several estimators — a few seconds.</div>
              </div>
            }

            @case ('error') {
              <div class="mic-note err">
                <b>{{ errorMsg() }}</b>
                @if (errorHint()) { <div class="muted">{{ errorHint() }}</div> }
              </div>
              <div class="mic-actions">
                <button class="btn primary" (click)="start()">↺ Try again</button>
                <button class="btn" (click)="closed.emit()">Close</button>
              </div>
            }

            @case ('result') {
              @if (result(); as r) {
                <div class="mic-results">
                  <div class="mic-card" [class.weak]="!r.keyReliable">
                    <div class="mic-card-head">
                      <label class="mic-check">
                        <input type="checkbox" [checked]="useKey()" [disabled]="!r.camelot"
                               (change)="useKey.set($any($event.target).checked)" />
                        Key
                      </label>
                      <span class="spacer"></span>
                      <span class="mic-conf" [class.weak]="!r.keyReliable">
                        {{ percent(r.keyConfidence) }} confident
                      </span>
                    </div>
                    @if (r.camelot) {
                      <div [class]="'big-key ' + keyClass(chosenCamelot())">
                        {{ chosenCamelot() }} — {{ keyNameOf(chosenCamelot()) }}
                      </div>
                      <div class="mic-field">
                        <label>Correct it if you disagree</label>
                        <select class="ef-select" (change)="chosenCamelot.set($any($event.target).value)">
                          @for (c of camelotOptions; track c) {
                            <option [value]="c" [selected]="c === chosenCamelot()">{{ c }} — {{ keyNameOf(c) }}</option>
                          }
                        </select>
                      </div>
                      @if (r.runnerUpCamelot) {
                        <button class="btn" (click)="chosenCamelot.set(r.runnerUpCamelot)">
                          Use runner-up {{ r.runnerUpCamelot }} ({{ keyNameOf(r.runnerUpCamelot) }})
                        </button>
                      }
                      @if (r.keyNotesCertain && r.keyModeUncertain) {
                        <div class="muted">
                          Both readings sit at <b>{{ wheelNumber(r.camelot) }}</b> on the wheel,
                          so either one mixes with exactly the same records.
                        </div>
                      }
                      @if (keyDiffers()) {
                        <div class="muted">Currently saved: <b>{{ track()!.keyText }}</b></div>
                      }
                    } @else {
                      <div class="muted">No key could be agreed on.</div>
                    }
                  </div>

                  <div class="mic-card" [class.weak]="!r.bpmReliable">
                    <div class="mic-card-head">
                      <label class="mic-check">
                        <input type="checkbox" [checked]="useBpm()" [disabled]="!r.bpm"
                               (change)="useBpm.set($any($event.target).checked)" />
                        BPM
                      </label>
                      <span class="spacer"></span>
                      <span class="mic-conf" [class.weak]="!r.bpmReliable">
                        {{ percent(r.bpmConfidence) }} confident
                      </span>
                    </div>
                    @if (r.bpm) {
                      <div class="big-key mic-bpm">{{ chosenBpm() || '—' }}<span class="mic-unit">BPM</span></div>
                      <div class="muted">Measured {{ r.bpmExact }} BPM</div>
                      <div class="mic-field">
                        <label>Correct it if you disagree</label>
                        <input class="ef-input" type="number" min="0" step="1"
                               [value]="chosenBpm()" (input)="chosenBpm.set($any($event.target).value)" />
                      </div>
                      @if (r.altBpm) {
                        <button class="btn" (click)="useAlt(r.altBpm)">
                          Use half/double time: {{ r.altBpm }} BPM
                        </button>
                      }
                      @if (bpmDiffers()) {
                        <div class="muted">Currently saved: <b>{{ track()!.bpm }} BPM</b></div>
                      }
                    } @else {
                      <div class="muted">No tempo could be found.</div>
                    }
                  </div>
                </div>

                @for (n of r.notes; track n) {
                  <div class="mic-note warn">⚠ {{ n }}</div>
                }

                @if (!r.keyReliable || !r.bpmReliable) {
                  <div class="mic-note">
                    Anything the analysis wasn't sure about is left un-ticked on purpose.
                    Recording a longer, steadier fragment is usually a better fix than
                    accepting a shaky number.
                  </div>
                }

                <button class="btn mic-detail-toggle" (click)="showDetail.set(!showDetail())">
                  {{ showDetail() ? '▾' : '▸' }} How it decided
                </button>
                @if (showDetail()) {
                  <div class="mic-detail">
                    <div class="mic-detail-col">
                      <b>Key estimates</b>
                      @for (v of r.votes; track v.label) {
                        <div [class.win]="v.camelot === r.camelot">
                          {{ v.camelot }} <span class="muted">{{ v.label }} · strength {{ v.strength.toFixed(2) }}</span>
                        </div>
                      }
                    </div>
                    <div class="mic-detail-col">
                      <b>Tempo estimates</b>
                      @for (e of r.bpmEstimates; track e.label) {
                        <div>{{ e.bpm }} <span class="muted">{{ e.label }}</span></div>
                      }
                      <div class="muted">{{ r.durationSec.toFixed(1) }}s analysed</div>
                    </div>
                  </div>
                }
              }
            }
          }
        </div>

        @if (stage() === 'result') {
          <div class="modal-foot">
            <button class="btn" (click)="start()">↺ Listen again</button>
            <span class="spacer"></span>
            <button class="btn" (click)="closed.emit()">Cancel</button>
            <button class="btn primary" [disabled]="!canApply()" (click)="apply()">
              ✓ Save {{ applyLabel() }}
            </button>
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      .modal.mic { width: min(720px, 100%); max-height: 90vh; }
      .mic-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
      .mic-track { font-size: 14px; }
      .mic-steps { margin: 0; padding-left: 20px; line-height: 1.6; font-size: 13px; }
      .mic-len { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
      .mic-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .mic-live { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 12px 0; }
      .mic-count { font-size: 40px; font-weight: 700; font-variant-numeric: tabular-nums; }
      .mic-meter, .mic-progress {
        width: 100%; height: 12px; border-radius: 6px; overflow: hidden;
        background: rgba(255, 255, 255, .08);
      }
      .mic-progress { height: 6px; }
      .mic-meter-fill { height: 100%; background: #4ec9a0; transition: width .08s linear; }
      .mic-meter.low .mic-meter-fill { background: #8a8a8a; }
      .mic-meter.hot .mic-meter-fill { background: #ff6b81; }
      .mic-progress-fill { height: 100%; background: currentColor; opacity: .5; transition: width .25s linear; }
      .mic-results { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      @media (max-width: 640px) { .mic-results { grid-template-columns: 1fr; } }
      .mic-card {
        border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
        display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
      }
      .mic-card.weak { border-style: dashed; opacity: .92; }
      .mic-card-head { display: flex; align-items: center; gap: 8px; width: 100%; font-weight: 600; }
      .mic-card-head .spacer { flex: 1; }
      .mic-check { display: flex; align-items: center; gap: 6px; cursor: pointer; }
      .mic-conf { font-size: 12px; color: #4ec9a0; }
      .mic-conf.weak { color: #ffb46b; }
      .mic-bpm { font-variant-numeric: tabular-nums; }
      .mic-unit { font-size: 13px; margin-left: 6px; opacity: .7; }
      .mic-field { display: flex; flex-direction: column; gap: 4px; width: 100%; font-size: 12px; }
      .mic-note { font-size: 13px; line-height: 1.5; border-left: 3px solid var(--border); padding-left: 10px; }
      .mic-note.warn { border-left-color: #ffb46b; }
      .mic-note.err { border-left-color: #ff6b81; }
      .mic-detail-toggle { align-self: flex-start; }
      .mic-detail { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 12px; line-height: 1.7; }
      .mic-detail .win { font-weight: 700; }
    `,
  ],
})
export class MicAnalyzeComponent implements OnDestroy {
  /** The track being measured — shown for context and compared against. */
  readonly track = input<Track | undefined>(undefined);

  /** Emitted when the user accepts some or all of the findings. */
  readonly applied = output<AnalysisApply>();
  readonly closed = output<void>();

  readonly supported = micSupported();
  readonly lengths = LENGTHS;
  readonly minSeconds = MIN_ANALYSIS_SECONDS;
  readonly camelotOptions = CAMELOT_CODES;

  readonly stage = signal<Stage>('idle');
  readonly seconds = signal(DEFAULT_LISTEN_SECONDS);
  readonly elapsed = signal(0);
  readonly rms = signal(0);
  readonly peak = signal(0);
  readonly status = signal('Analysing…');
  readonly result = signal<AnalysisResult | null>(null);
  readonly errorMsg = signal('');
  readonly errorHint = signal('');
  readonly showDetail = signal(false);

  /** What will actually be written — seeded from the analysis, editable by the user. */
  readonly chosenCamelot = signal('');
  readonly chosenBpm = signal('');
  readonly useKey = signal(false);
  readonly useBpm = signal(false);

  private recorder: MicRecorder | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // The WASM engine is a few megabytes; fetching it while the user reads the
    // instructions means "Start listening" doesn't stall on a download.
    if (this.supported) preloadEssentia();
  }

  ngOnDestroy(): void {
    this.teardown();
  }

  readonly remaining = computed(() => Math.max(0, Math.ceil(this.seconds() - this.elapsed())));
  readonly progress = computed(() => Math.min(100, (this.elapsed() / this.seconds()) * 100));

  /** Meter width on a rough dB scale — a linear RMS bar barely moves. */
  readonly meterWidth = computed(() => {
    const r = this.rms();
    if (r <= 0) return 0;
    const db = 20 * Math.log10(r); // -60 dB … 0 dB
    return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  });

  readonly keyDiffers = computed(() => {
    const t = this.track();
    return !!t?.camelot && t.camelot.toUpperCase() !== this.chosenCamelot();
  });

  readonly bpmDiffers = computed(() => {
    const t = this.track();
    return !!t?.bpm && t.bpm.trim() !== this.chosenBpm().trim();
  });

  readonly canApply = computed(
    () => (this.useKey() && !!this.chosenCamelot()) || (this.useBpm() && !!this.chosenBpm().trim())
  );

  readonly applyLabel = computed(() => {
    const k = this.useKey() && !!this.chosenCamelot();
    const b = this.useBpm() && !!this.chosenBpm().trim();
    return k && b ? 'key and BPM' : k ? 'key' : b ? 'BPM' : 'nothing';
  });

  keyNameOf(code: string): string {
    return camelotToKeyName(code);
  }

  keyClass(code: string): string {
    return camelotClass(code);
  }

  percent(n: number): string {
    return Math.round(n * 100) + '%';
  }

  /** Switches the proposed tempo to its half/double-time reading. */
  useAlt(bpm: number): void {
    this.chosenBpm.set(String(Math.round(bpm)));
  }

  /** The wheel position of a Camelot code: "8A" → "8". */
  wheelNumber(camelot: string): string {
    return /^(\d{1,2})[AB]$/.exec(camelot)?.[1] ?? camelot;
  }

  /** Opens the microphone and runs the clock; auto-stops at the chosen length. */
  async start(): Promise<void> {
    this.teardown();
    this.result.set(null);
    this.elapsed.set(0);
    this.rms.set(0);
    this.peak.set(0);
    this.showDetail.set(false);
    this.stage.set('recording');

    const rec = new MicRecorder();
    this.recorder = rec;
    try {
      await rec.start((level) => {
        this.rms.set(level.rms);
        this.peak.set(level.peak);
        this.elapsed.set(level.elapsed);
      });
    } catch (e) {
      this.fail(e);
      return;
    }

    // The level callback already tracks elapsed time, but it stops firing if the
    // audio graph stalls; an independent clock guarantees the auto-stop happens.
    this.ticker = setInterval(() => {
      if (this.stage() !== 'recording') return;
      if (rec.elapsed >= this.seconds()) void this.stop();
    }, 200);
  }

  /** Ends the capture and hands it to the analysis. */
  async stop(): Promise<void> {
    const rec = this.recorder;
    if (!rec || this.stage() !== 'recording') return;
    this.clearTicker();
    this.stage.set('analysing');
    this.status.set('Preparing audio…');

    let audio: Recording;
    try {
      audio = await rec.stop();
    } catch (e) {
      this.fail(e);
      return;
    } finally {
      this.recorder = null;
    }

    try {
      const result = await analyseRecording(audio, (m) => this.status.set(m));
      this.result.set(result);
      this.chosenCamelot.set(result.camelot);
      this.chosenBpm.set(result.bpm);
      // Only a result the analysis itself vouches for arrives pre-ticked.
      this.useKey.set(result.keyReliable && !!result.camelot);
      this.useBpm.set(result.bpmReliable && !!result.bpm);
      this.stage.set('result');
    } catch (e) {
      this.fail(e);
    }
  }

  cancel(): void {
    this.teardown();
    this.closed.emit();
  }

  /** Ignores clicks on the backdrop while a analysis is mid-flight. */
  tryClose(): void {
    if (this.stage() === 'analysing') return;
    this.cancel();
  }

  apply(): void {
    const camelot = this.useKey() ? this.chosenCamelot().trim().toUpperCase() : null;
    const bpm = this.useBpm() ? this.chosenBpm().trim() : null;
    this.teardown();
    this.applied.emit({ camelot, bpm });
  }

  private fail(e: unknown): void {
    this.teardown();
    if (e instanceof MicError || e instanceof AnalysisError) {
      this.errorMsg.set(e.message);
      this.errorHint.set(e.hint);
    } else {
      this.errorMsg.set('The analysis failed.');
      this.errorHint.set(String(e));
    }
    this.stage.set('error');
  }

  /** Releases the microphone. Called on every exit path, including destruction. */
  private teardown(): void {
    this.clearTicker();
    this.recorder?.cancel();
    this.recorder = null;
  }

  private clearTicker(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
  }
}





