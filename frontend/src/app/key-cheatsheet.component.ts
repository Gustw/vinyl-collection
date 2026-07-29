import { Component, computed, inject, input, output, signal } from '@angular/core';
import { ConfigService } from './config.service';
import {
  CAMELOT_CODES,
  camelotClass,
  camelotToKeyName,
  mixableCamelot,
  percentForSemitones,
  relation,
  semitonesForPercent,
  shiftCamelot,
  withinPitchRange,
} from './camelot';

/** One "this key mixes with that key, because…" line. */
interface MixRow {
  code: string;
  name: string;
  rel: string;
  why: string;
}

/** One rung of the pitch-fader table. */
interface PitchRow {
  semitones: number;
  percent: number;
  code: string;
  name: string;
  reachable: boolean;
}

/**
 * Why each relationship works, in the terms you'd actually think in behind the
 * decks. The keys are the labels `relation()` produces.
 */
const WHY: Record<string, string> = {
  'Same key':
    'Identical key — nothing can clash. The safest mix, and the only one that holds up over a long blend.',
  '+1 energy':
    'One step clockwise (a fifth up). Lifts the set without changing its mood. The workhorse move.',
  '-1 energy':
    'One step anti-clockwise (a fifth down). Eases the set back down again.',
  Relative:
    'Relative major/minor — the same notes, a different home note. Trades dark for bright without leaving the scale.',
  'Same root':
    'Parallel major/minor — same root note, opposite mode. A bigger emotional switch, so keep the blend short.',
  '+1 energy boost':
    'Up a semitone. A hard lift that the ear notices, so cut to it rather than riding it for 32 bars.',
  '-1 energy drop':
    'Down a semitone. The same jolt in reverse — useful for darkening a room quickly.',
  '+2 energy boost':
    'Up a whole tone. The classic key change: big, obvious, and it wants a clean cut.',
  '-2 energy drop':
    'Down a whole tone. A pronounced drop in brightness.',
};

/** Sort order for the mixable list — safest first, boldest last. */
const REL_ORDER = [
  'Same key',
  '+1 energy',
  '-1 energy',
  'Relative',
  'Same root',
  '+1 energy boost',
  '-1 energy drop',
  '+2 energy boost',
  '-2 energy drop',
];

/** Maps a relationship label to its badge colour class (as the detail screen does). */
function relClass(rel: string): string {
  switch (rel) {
    case 'Same key':
      return 'rel-same';
    case 'Same root':
      return 'rel-root';
    case 'Relative':
      return 'rel-relative';
    case '+1 energy':
    case '-1 energy':
      return 'rel-energy';
  }
  if (rel.includes('boost')) return 'rel-boost';
  if (rel.includes('drop')) return 'rel-drop';
  return 'rel-compatible';
}

/**
 * A reference card for harmonic mixing: what mixes with a given key and why,
 * and what the pitch fader does to that key on the way.
 *
 * It exists because the two facts that matter most are the two that are least
 * obvious — that pitching a record transposes it, and that one semitone is
 * *seven* positions around the Camelot wheel rather than one.
 */
@Component({
  selector: 'app-key-cheatsheet',
  standalone: true,
  template: `
    <div class="modal-backdrop" (click)="closed.emit()">
      <div class="modal cheat" (click)="$event.stopPropagation()">
        <div class="modal-head">
          <h2>🎹 Key &amp; pitch cheat sheet</h2>
          <span class="spacer"></span>
          <button class="btn" (click)="closed.emit()">✕</button>
        </div>

        <div class="modal-body cheat-body">
          <div class="cheat-picker">
            <div class="muted">Everything below is relative to this key — tap another to change it.</div>
            <div class="cheat-keys">
              @for (c of codes; track c) {
                <span
                  [class]="'key-badge cheat-key ' + keyClass(c)"
                  [class.active]="c === key()"
                  (click)="setKey(c)"
                >{{ c }}</span>
              }
            </div>
            <div [class]="'big-key ' + keyClass(key())">{{ key() }} — {{ keyName() }}</div>
          </div>

          <h3 class="cheat-h">What mixes with {{ key() }}, and why</h3>
          <div class="cheat-rows">
            @for (m of mixes(); track m.code) {
              <div class="cheat-row">
                <span [class]="'key-badge ' + keyClass(m.code)">{{ m.code }} · {{ m.name }}</span>
                <span [class]="'rel-badge ' + relBadge(m.rel)">{{ m.rel }}</span>
                <span class="cheat-why">{{ m.why }}</span>
              </div>
            }
          </div>

          <h3 class="cheat-h">What the pitch fader does to the key</h3>
          <p class="cheat-note">
            On vinyl, speed <i>is</i> pitch: the fader doesn't only change the tempo, it
            transposes the record — roughly <b>6% per semitone</b>. And a semitone moves the key
            <b>seven positions</b> around the wheel, not one, which is why a pitched-up record can
            suddenly clash with something that looked compatible on the label.
          </p>
          <div class="cheat-rows">
            @for (p of pitchRows(); track p.semitones) {
              <div class="cheat-row">
                <span class="pitch-badge" [class.out]="!p.reachable" [title]="p.reachable ? '' : outOfRangeTitle()">
                  {{ pct(p.percent) }}
                </span>
                <span class="tag">{{ semis(p.semitones) }}</span>
                <span [class]="'key-badge ' + keyClass(p.code)">
                  {{ p.semitones === 0 ? key() + ' · ' + keyName() : p.code + ' · ' + p.name }}
                </span>
                <span class="cheat-why">
                  @if (p.semitones === 0) {
                    Fader at zero — the record plays in the key on the label.
                  } @else if (!p.reachable) {
                    Beyond your ±{{ range() }}% decks — this one needs a different pressing, not a fader.
                  } @else {
                    {{ key() }} becomes {{ p.code }}: {{ relFor(p.code) }}.
                  }
                </span>
              </div>
            }
          </div>
          <div class="pitch-hidden-note">
            Your decks are set to <b>±{{ range() }}%</b>, which reaches
            <b>±{{ reach() }} semitones</b>. Anything between the rungs above lands between keys;
            when a pitched record is re-labelled here it is rounded to the nearest semitone.
            Beat-matching at half or double tempo doesn't count as a pitch change at all — a
            70 BPM record against a 140 BPM one sits at 0% and keeps its key.
          </div>

          <h3 class="cheat-h">The wheel</h3>
          <div class="cheat-wheel">
            <div class="cw-head">#</div>
            <div class="cw-head">A — minor</div>
            <div class="cw-head">B — major</div>
            @for (n of wheel; track n) {
              <div class="cw-num">{{ n }}</div>
              <div>
                <span
                  [class]="'key-badge ' + keyClass(n + 'A')"
                  [class.active]="key() === n + 'A'"
                  (click)="setKey(n + 'A')"
                >{{ n }}A · {{ nameOf(n + 'A') }}</span>
              </div>
              <div>
                <span
                  [class]="'key-badge ' + keyClass(n + 'B')"
                  [class.active]="key() === n + 'B'"
                  (click)="setKey(n + 'B')"
                >{{ n }}B · {{ nameOf(n + 'B') }}</span>
              </div>
            }
          </div>
        </div>
      </div>
    </div>
  `,
})
export class KeyCheatsheetComponent {
  private readonly config = inject(ConfigService);

  /** Key to open on — the track you came from, when there is one. */
  readonly startKey = input('8A');
  readonly closed = output<void>();

  readonly codes = CAMELOT_CODES;
  readonly wheel = Array.from({ length: 12 }, (_, i) => i + 1);

  /**
   * The key everything is shown relative to: whatever the caller opened us on
   * until the user picks another, and their choice from then on.
   *
   * Deliberately a computed over an override rather than a signal seeded in the
   * constructor — a signal input is not bound yet when the constructor runs, so
   * seeding there would silently ignore the track you came from.
   */
  private readonly picked = signal<string | null>(null);
  readonly key = computed(() => {
    const chosen = this.picked();
    if (chosen) return chosen;
    const start = this.startKey();
    return CAMELOT_CODES.includes(start) ? start : '8A';
  });

  setKey(code: string): void {
    this.picked.set(code);
  }

  readonly keyName = computed(() => camelotToKeyName(this.key()));

  /** Turntable pitch range from settings (8% on a stock Technics). */
  readonly range = computed(() => {
    const r = Number(this.config.config().pitchRange);
    return Number.isFinite(r) && r > 0 ? r : 8;
  });

  /** How many semitones that range reaches, e.g. 1.33 at ±8%. */
  readonly reach = computed(() => semitonesForPercent(this.range()).toFixed(2));

  readonly mixes = computed<MixRow[]>(() => {
    const base = this.key();
    const seen = new Set<string>();
    const rows: MixRow[] = [];
    for (const code of mixableCamelot(base)) {
      if (seen.has(code)) continue; // the wheel can name the same key twice
      seen.add(code);
      const rel = relation(base, code);
      rows.push({
        code,
        name: camelotToKeyName(code),
        rel,
        why: WHY[rel] ?? 'Compatible, but an unusual interval — trust your ears on this one.',
      });
    }
    return rows.sort((a, b) => order(a.rel) - order(b.rel));
  });

  readonly pitchRows = computed<PitchRow[]>(() =>
    [-2, -1, 0, 1, 2].map((st) => {
      const percent = percentForSemitones(st);
      const code = shiftCamelot(this.key(), st);
      return {
        semitones: st,
        percent,
        code,
        name: camelotToKeyName(code),
        reachable: withinPitchRange(percent, this.range()),
      };
    })
  );

  keyClass(code: string): string {
    return camelotClass(code);
  }

  nameOf(code: string): string {
    return camelotToKeyName(code);
  }

  relBadge(rel: string): string {
    return relClass(rel);
  }

  /** Relationship of a pitched key back to the reference, lower-cased mid-sentence. */
  relFor(code: string): string {
    const r = relation(this.key(), code);
    return r ? r.charAt(0).toLowerCase() + r.slice(1) : 'a different key';
  }

  /** "+5.9%" / "−5.6%" / "0%". */
  pct(percent: number): string {
    if (Math.abs(percent) < 0.05) return '0%';
    return `${percent > 0 ? '+' : '−'}${Math.abs(percent).toFixed(1)}%`;
  }

  /** "+1 st" / "−2 st" / "0". */
  semis(st: number): string {
    if (st === 0) return 'no shift';
    return `${st > 0 ? '+' : '−'}${Math.abs(st)} st`;
  }

  outOfRangeTitle(): string {
    return `More pitch than your ±${this.range()}% turntables can give`;
  }
}

function order(rel: string): number {
  const i = REL_ORDER.indexOf(rel);
  return i === -1 ? REL_ORDER.length : i;
}






