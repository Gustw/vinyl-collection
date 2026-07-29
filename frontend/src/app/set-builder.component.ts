import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink, Router } from '@angular/router';
import { CollectionService } from './collection.service';
import { CrateService } from './crate.service';
import { ConfigService } from './config.service';
import { Track, trackKey } from './models';
import { camelotClass } from './camelot';
import { Transition, evaluateSet, formatPercent } from './transitions';

/**
 * Set builder: takes a crate, puts it in playing order, and lints every
 * transition in it — the junction between two records is where a set is won
 * or lost, and it is exactly what is hard to check in your head.
 */
@Component({
  selector: 'app-set-builder',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="topbar">
      <a routerLink="/" class="btn">← Back to list</a>
      <h1 style="margin-left:8px">Set builder</h1>
      <span class="spacer"></span>
      @if (crate()) {
        <span class="badge-count">{{ tracks().length }} track(s)</span>
        @if (blockedCount()) {
          <span class="badge-count err" title="The decks can't close the tempo gap">
            {{ blockedCount() }} unplayable transition(s)
          </span>
        }
        @if (warningCount()) {
          <span class="badge-count warn-count" title="Playable, but worth listening to first">
            {{ warningCount() }} to watch
          </span>
        }
        @if (!blockedCount() && !warningCount() && tracks().length > 1) {
          <span class="badge-count ok-count">all transitions work</span>
        }
      }
    </div>

    <div class="container">
      <div class="panel filters">
        <label for="set-crate">Crate</label>
        <select id="set-crate" class="crate-name" (change)="crateId.set($any($event.target).value)">
          <option value="">— pick a crate —</option>
          @for (c of crateSvc.crates(); track c.id) {
            <option [value]="c.id" [selected]="c.id === crateId()">{{ c.name }} ({{ c.trackKeys.length }})</option>
          }
        </select>
        @if (crateSvc.crates().length === 0) {
          <div class="muted" style="margin-top:8px">
            No crates yet — build one from the <a routerLink="/">collection</a> first.
          </div>
        }
      </div>

      @if (crate()) {
        @if (tracks().length === 0) {
          <div class="panel empty">This crate is empty. Add tracks to it from the collection.</div>
        } @else {
          <div class="panel set-summary">
            @if (bpmRange()) { <span class="muted">BPM {{ bpmRange() }}</span> }
            <span class="spacer"></span>
            <button class="btn" [disabled]="tracks().length < 2" (click)="autoOrder()">
              ✨ Auto-order for smoothest mixes
            </button>
          </div>

          <div class="panel set-list">
            @for (t of tracks(); track t.id; let i = $index) {
              <div class="set-item">
                <span class="set-pos">{{ i + 1 }}</span>
                @if (t.artwork) {
                  <img class="cover" [src]="t.artwork" alt="" loading="lazy" referrerpolicy="no-referrer" />
                } @else {
                  <span class="cover cover-none" aria-hidden="true">♪</span>
                }
                <div class="set-track" (click)="open(t)">
                  <div class="track-title">{{ t.title }}</div>
                  <div class="muted">{{ t.artist }} · {{ t.recordTitle }}</div>
                </div>
                @if (t.bpm) { <span class="bpm-badge">{{ t.bpm }} BPM</span> }
                <span [class]="'key-badge ' + keyClass(t.camelot)">{{ t.keyText || 'no key' }}</span>
                <div class="set-actions">
                  <button class="btn" [disabled]="i === 0" title="Move up" (click)="move(i, i - 1)">↑</button>
                  <button class="btn" [disabled]="i === tracks().length - 1" title="Move down" (click)="move(i, i + 1)">↓</button>
                  <button class="btn danger" title="Remove from crate" (click)="remove(t)">✕</button>
                </div>
              </div>

              @if (transitionAfter(i); as tr) {
                <div [class]="'transition ' + tr.level">
                  <span class="tr-icon">{{ icon(tr) }}</span>
                  <span class="tr-main">
                    {{ tr.fromCamelot || '?' }} → {{ tr.effectiveCamelot || '?' }}
                    @if (tr.relation) { <span class="muted">({{ tr.relation }})</span> }
                  </span>
                  <span class="muted">{{ mixTempoLabel(tr) }}</span>
                  @if (tr.fromPercent !== null) {
                    <span
                      class="pitch-badge"
                      [class.out]="!tr.reachable"
                      title="Where each fader sits during the blend: outgoing → incoming"
                    >{{ pct(tr.fromPercent) }} → {{ pct(tr.percent!) }}</span>
                  }
                  @if (tr.bpmDelta !== null) {
                    <span class="muted">{{ bpmDeltaLabel(tr.bpmDelta) }}</span>
                  }
                  @for (msg of tr.issues; track msg) {
                    <span class="tr-issue">{{ msg }}</span>
                  }
                </div>
              }
            }
          </div>
        }
      }
    </div>
  `,
})
export class SetBuilderComponent {
  readonly col = inject(CollectionService);
  readonly crateSvc = inject(CrateService);
  private readonly config = inject(ConfigService);
  private readonly router = inject(Router);

  readonly crateId = signal('');

  readonly pitchRange = computed(() => {
    const r = Number(this.config.config().pitchRange);
    return Number.isFinite(r) && r > 0 ? r : 8;
  });

  readonly crate = computed(() => (this.crateId() ? this.crateSvc.byId(this.crateId()) : undefined));
  readonly tracks = computed<Track[]>(() =>
    this.crateId() ? this.crateSvc.tracksOf(this.crateId()) : []
  );

  readonly transitions = computed<Transition[]>(() =>
    evaluateSet(this.tracks(), this.pitchRange())
  );

  /** Transitions the decks physically cannot make. */
  readonly blockedCount = computed(
    () => this.transitions().filter((t) => t.level === 'bad').length
  );

  /** Transitions that will play but want an ear on them — clashing keys, mostly. */
  readonly warningCount = computed(
    () => this.transitions().filter((t) => t.level === 'warn').length
  );

  /** "118 – 132" across the set, or '' when no BPMs are known. */
  readonly bpmRange = computed(() => {
    const bpms = this.tracks()
      .map((t) => parseFloat(t.bpm))
      .filter((b) => !Number.isNaN(b) && b > 0);
    if (!bpms.length) return '';
    const lo = Math.min(...bpms);
    const hi = Math.max(...bpms);
    return lo === hi ? `${lo}` : `${lo} – ${hi}`;
  });

  /** The transition that follows position `i`, if any. */
  transitionAfter(i: number): Transition | undefined {
    return this.transitions()[i];
  }

  icon(t: Transition): string {
    return t.level === 'good' ? '✓' : t.level === 'warn' ? '!' : '✕';
  }

  pct(percent: number): string {
    return formatPercent(percent);
  }

  /** The tempo a blend happens at, e.g. "@ 128.4 BPM". */
  mixTempoLabel(t: Transition): string {
    return t.mixTempo === null ? '' : `@ ${t.mixTempo.toFixed(1)} BPM`;
  }

  bpmDeltaLabel(delta: number): string {
    if (Math.abs(delta) < 0.05) return 'same BPM';
    const sign = delta > 0 ? '+' : '−';
    return `${sign}${Math.abs(delta).toFixed(0)} BPM`;
  }

  keyClass(camelot: string): string {
    return camelotClass(camelot);
  }

  move(from: number, to: number): void {
    this.crateSvc.move(this.crateId(), from, to);
  }

  remove(t: Track): void {
    this.crateSvc.removeTrack(this.crateId(), t);
  }

  open(t: Track): void {
    this.router.navigate(['/track', t.id]);
  }

  /**
   * Greedily reorders the crate so each record leads into the next as smoothly
   * as possible: start from the slowest track, then repeatedly pick whichever
   * remaining record makes the best transition. Greedy rather than optimal —
   * this is travelling-salesman shaped — but it reliably clears the obviously
   * broken junctions, and the order stays editable by hand afterwards.
   */
  autoOrder(): void {
    const pool = [...this.tracks()];
    if (pool.length < 2) return;

    const bpmOf = (t: Track) => {
      const b = parseFloat(t.bpm);
      return Number.isNaN(b) ? Infinity : b;
    };
    // Start slow so the set naturally builds in tempo.
    pool.sort((a, b) => bpmOf(a) - bpmOf(b));

    const ordered: Track[] = [pool.shift()!];
    while (pool.length) {
      let bestIdx = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const score = this.transitionScore(ordered[ordered.length - 1], pool[i]);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      ordered.push(pool.splice(bestIdx, 1)[0]);
    }

    this.crateSvc.setOrder(
      this.crateId(),
      ordered.map((t) => trackKey(t))
    );
  }

  /** Higher is a smoother mix; used only to rank candidates in autoOrder(). */
  private transitionScore(from: Track, to: Track): number {
    const tr = evaluateSet([from, to], this.pitchRange())[0];
    let score = tr.level === 'good' ? 100 : tr.level === 'warn' ? 50 : 0;
    if (tr.harmonic) score += 40;
    if (tr.relation === 'Same key') score += 10;
    // Prefer small tempo moves, and nudge the set upward rather than downward.
    if (tr.percent !== null) {
      score -= Math.max(Math.abs(tr.percent), Math.abs(tr.fromPercent ?? 0)) * 2;
    }
    if (tr.bpmDelta !== null && tr.bpmDelta >= 0) score += 3;
    return score;
  }
}

