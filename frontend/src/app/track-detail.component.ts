import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CollectionService } from './collection.service';
import { CrateService, inAnyCrate } from './crate.service';
import { FilterStateService, activeFilterCount, hasActiveFilters } from './filter-state.service';
import { matchesTrack } from './filtering';
import {
  mixableCamelot,
  relation,
  pitchShiftSemitones,
  pitchPercent,
  withinPitchRange,
  shiftCamelot,
  shiftKeyName,
  camelotClass,
  CAMELOT_CODES,
  camelotToKeyName,
} from './camelot';
import { Track } from './models';
import { ConfigService } from './config.service';
import { Bridge, RouteRecord, findBridges } from './bridge';
import { Transition, formatPercent } from './transitions';
import { KeyCheatsheetComponent } from './key-cheatsheet.component';
import { AnalysisApply, MicAnalyzeComponent } from './mic-analyze.component';

const REL_ORDER: Record<string, number> = {
  'Same key': 0,
  'Same root': 1,
  Relative: 2,
  '+1 energy': 3,
  '-1 energy': 4,
  '+1 energy boost': 5,
  '-1 energy drop': 6,
  '+2 energy boost': 7,
  '-2 energy drop': 8,
  '+3 energy boost': 9,
  '-3 energy drop': 10,
  '+4 energy boost': 11,
  '-4 energy drop': 12,
  '+6 energy boost': 13,
  Compatible: 14,
};

/** A doubled tempo as text, keeping a half-BPM but never inventing precision. */
function doubledText(bpm: number): string {
  return String(Math.round(bpm * 2 * 10) / 10);
}

/** A mixable candidate together with its (optionally pitch-adjusted) key. */
interface Row {
  track: Track;
  /** true when the key was shifted to beat-match the current track's BPM. */
  adjusted: boolean;
  /** signed semitone shift applied (0 when not adjusted). */
  semis: number;
  /** effective Camelot code after any pitch adjustment. */
  camelot: string;
  /** effective key name after any pitch adjustment. */
  keyName: string;
  /**
   * Platter pitch needed to beat-match this track to the current one, in
   * percent, or null when either BPM is unknown.
   */
  percent: number | null;
  /** false when `percent` exceeds the configured turntable range. */
  reachable: boolean;
}

@Component({
  selector: 'app-track-detail',
  standalone: true,
  imports: [RouterLink, KeyCheatsheetComponent, MicAnalyzeComponent],
  template: `
    <div class="topbar">
      <a routerLink="/" class="btn">← Back to list</a>
      <h1 style="margin-left:8px">Track detail</h1>
      <span class="spacer"></span>
      @if (track()) {
        <span class="badge-count">{{ shown() }} mixable track(s)</span>
      }
      <button
        class="btn"
        title="How pitch changes the key, and what mixes with what"
        (click)="showCheatsheet.set(true)"
      >
        🎹 Keys
      </button>
    </div>

    @if (showCheatsheet()) {
      <app-key-cheatsheet [startKey]="track()?.camelot || '8A'" (closed)="showCheatsheet.set(false)" />
    }

    @if (showMic()) {
      <app-mic-analyze
        [track]="track()"
        (applied)="applyAnalysis($event)"
        (closed)="showMic.set(false)"
      />
    }

    <div class="container">
      @if (!col.loaded()) {
        <div class="panel empty">Loading…</div>
      } @else if (!track()) {
        <div class="panel empty">Track not found. <a routerLink="/">Go back</a>.</div>
      } @else {
        <div class="panel">
          <div class="detail-head">
            @if (track()!.artwork) {
              <img class="cover-lg" [src]="track()!.artwork" alt="" referrerpolicy="no-referrer" />
            } @else {
              <span class="cover-lg cover-none" aria-hidden="true">♪</span>
            }
            <div style="flex:1">
              <div [class]="'big-key ' + keyClass(track()!.camelot)">{{ track()!.keyText || 'No key detected' }}</div>
              <div style="height:10px"></div>
              <div class="detail-grid">
                <div class="k">Title</div><div>{{ track()!.title }}</div>
                <div class="k">Artist</div><div>{{ track()!.artist }}</div>
                <div class="k">Record</div><div>{{ track()!.recordTitle }} — {{ track()!.recordArtist }}</div>
                <div class="k">Position</div>
                <div>
                  @if (track()!.position) {
                    <span class="pos-badge" title="Side and cut on the record">{{ track()!.position }}</span>
                  } @else { — }
                </div>
                <div class="k">Length</div><div>{{ track()!.duration || '—' }}</div>
                <div class="k">Year</div><div>{{ track()!.year || '—' }}</div>
                <div class="k">Label</div><div>{{ track()!.labels.join(', ') || '—' }}</div>
                <div class="k">Key</div><div>{{ track()!.keyName || '—' }}</div>
                <div class="k">Camelot</div><div>{{ track()!.camelot || '—' }}</div>
                <div class="k">BPM</div><div>{{ track()!.bpm || '—' }}</div>
                <div class="k">Genre</div><div>{{ track()!.genres.join(', ') || '—' }}</div>
                <div class="k">Style</div><div>{{ track()!.styles.join(', ') || '—' }}</div>
              </div>

              @if (!editing()) {
                <div class="edit-row">
                  <button class="btn" (click)="startEdit()">✎ Edit key / BPM</button>
                  <button
                    class="btn"
                    title="Play the record and let the app work out the key and BPM by ear"
                    (click)="openMic()"
                  >🎤 Detect by listening</button>
                  @if (manualLock().key || manualLock().bpm) {
                    <span
                      class="chip active"
                      [title]="manualNote()"
                    >✎ {{ manualLabel() }} set by hand</span>
                    <button
                      class="btn"
                      title="Hand this track back to the automatic Beatport/tunebat lookups"
                      (click)="clearManual()"
                    >↺ Unlock</button>
                  }
                  @for (c of crateSvc.crates(); track c.id) {
                    <span
                      class="chip"
                      [class.active]="crateSvc.contains(c.id, track()!)"
                      [title]="crateSvc.contains(c.id, track()!) ? 'Remove from ' + c.name : 'Add to ' + c.name"
                      (click)="crateSvc.toggle(c.id, track()!)"
                    >🗃 {{ c.name }}</span>
                  }
                  @if (saveMsg(); as m) {
                    <span class="muted" [class.err]="saveErr()">{{ m }}</span>
                  }
                </div>
              } @else {
                <div class="edit-form">
                  <div class="ef-field">
                    <label>Key</label>
                    <!--
                      Selection is driven by [selected] on each option rather than
                      [value] on the select: a [value] binding on the parent is
                      applied before @for has created the options, so it would
                      match nothing and silently leave the field blank.
                    -->
                    <select class="ef-select" (change)="editCamelot.set($any($event.target).value)">
                      <option value="" [selected]="!editCamelot()">— none —</option>
                      @for (c of camelotOptions; track c) {
                        <option [value]="c" [selected]="c === editCamelot()">{{ c }} — {{ keyNameOf(c) }}</option>
                      }
                    </select>
                  </div>
                  <div class="ef-field">
                    <label>BPM</label>
                    <div class="ef-bpm">
                      <input
                        class="ef-input"
                        type="number"
                        min="0"
                        step="1"
                        placeholder="e.g. 128"
                        [value]="editBpm()"
                        (input)="editBpm.set($any($event.target).value)"
                      />
                      <!--
                        The one-tap fix for a half-time reading. Catalogues list
                        a 172 BPM roller as 86, and retyping the number by hand
                        is the sort of friction that leaves it wrong forever.
                      -->
                      <button
                        class="btn ef-x2"
                        type="button"
                        [disabled]="!canDoubleBpm()"
                        [title]="doubleBpmTitle()"
                        (click)="doubleBpm()"
                      >×2</button>
                    </div>
                  </div>
                  <div class="edit-actions">
                    <button class="btn primary" [disabled]="saving()" (click)="save()">
                      {{ saving() ? 'Saving…' : 'Save' }}
                    </button>
                    <button
                      class="btn"
                      [disabled]="saving()"
                      title="Play the record and let the app work out the key and BPM by ear"
                      (click)="openMic()"
                    >🎤 Detect by listening</button>
                    <button class="btn" [disabled]="saving()" (click)="cancelEdit()">Cancel</button>
                  </div>
                  @if (saveMsg(); as m) {
                    <div class="muted" [class.err]="saveErr()" style="width:100%">{{ m }}</div>
                  }
                </div>
              }
            </div>
          </div>
        </div>

        @if (!track()!.camelot) {
          <div class="panel empty">This track has no detected key, so mixable tracks can't be computed.</div>
        } @else {
          <div class="panel filters">
            <div class="muted" style="margin-bottom:6px">
              Mixable with <b>{{ track()!.camelot }}</b>: {{ mixSet().join(', ') }}
            </div>

            <div class="filters-head">
              <div class="filters-search">
                <label for="detail-search">Search</label>
                <input
                  id="detail-search"
                  type="text"
                  placeholder="Search mixable tracks…"
                  [value]="filters().search"
                  (input)="onSearch($any($event.target).value)"
                />
              </div>
              <button
                class="btn filters-toggle"
                [attr.aria-expanded]="!collapsed()"
                [title]="collapsed() ? 'Show all filters' : 'Fold filters (keep search)'"
                (click)="toggleCollapsed()"
              >
                {{ collapsed() ? '▸' : '▾' }} Filters
                @if (collapsed() && advancedCount()) { <span class="filters-count">{{ advancedCount() }}</span> }
              </button>
              @if (collapsed() && active()) {
                <button class="btn" (click)="clear()">Clear</button>
              }
            </div>

            @if (!collapsed()) {
            @if (crateSvc.crates().length) {
              <label>Crates <span class="muted" style="text-transform:none">— only mix from the box I'm bringing</span></label>
              <div class="chips">
                @for (c of crateSvc.crates(); track c.id) {
                  <span
                    class="chip"
                    [class.active]="filters().crates.includes(c.id)"
                    [title]="filters().crates.includes(c.id) ? 'Click to stop filtering on ' + c.name : 'Click to also mix from ' + c.name"
                    (click)="toggle('crates', c.id)"
                  >🗃 {{ c.name }} <span class="chip-count">{{ c.trackKeys.length }}</span></span>
                }
                @if (filters().crates.length) {
                  <span class="chip ghost" (click)="clearCrates()">✕ show all</span>
                }
              </div>
            }

            @if (optionGenres().length) {
              <label>Genres</label>
              <div class="chips">
                @for (g of optionGenres(); track g) {
                  <span class="chip" [class.active]="filters().genres.includes(g)" (click)="toggle('genres', g)">{{ g }}</span>
                }
              </div>
            }

            @if (optionStyles().length) {
              <label>Styles</label>
              <div class="chips">
                @for (s of optionStyles(); track s) {
                  <span class="chip" [class.active]="filters().styles.includes(s)" (click)="toggle('styles', s)">{{ s }}</span>
                }
              </div>
            }

            <label>Keys (Camelot)</label>
            <div class="chips">
              @for (k of optionKeys(); track k) {
                <span class="chip" [class.active]="filters().keys.includes(k)" (click)="toggle('keys', k)">{{ k }}</span>
              }
            </div>

            @if (optionTypes().length) {
              <label>Types</label>
              <div class="chips">
                @for (ty of optionTypes(); track ty) {
                  <span class="chip" [class.active]="!filters().hiddenTypes.includes(ty)" (click)="toggleType(ty)">{{ ty }}</span>
                }
              </div>
            }

            <label>BPM difference</label>
            @if (refBpm() === null) {
              <div class="muted">This track has no BPM, so BPM filtering is unavailable.</div>
            } @else {
              <label class="bpm-check">
                <input
                  type="checkbox"
                  [checked]="filters().bpmEnabled"
                  (change)="onBpmEnabled($any($event.target).checked)"
                />
                filter by BPM difference
              </label>
              @if (filters().bpmEnabled) {
                <div class="bpm-filter">
                  <span class="muted">± </span>
                  <input
                    class="bpm-input"
                    type="number"
                    min="0"
                    step="1"
                    placeholder="0"
                    [value]="filters().bpmRange || ''"
                    (input)="onBpmRange($any($event.target).value)"
                  />
                  <span class="muted">BPM from {{ refBpm() }}</span>
                  <label class="bpm-check">
                    <input
                      type="checkbox"
                      [checked]="filters().bpmDoubleHalf"
                      (change)="onBpmDoubleHalf($any($event.target).checked)"
                    />
                    match double / half tempo
                  </label>
                </div>
              }
            }

            <label>Pitch / key</label>
            <label class="bpm-check">
              <input
                type="checkbox"
                [checked]="filters().pitchLimit"
                (change)="onPitchLimit($any($event.target).checked)"
              />
              only mixes my decks can reach (± {{ pitchRange() }}%)
            </label>
            @if (filters().pitchLimit && unreachableCount()) {
              <div class="muted pitch-hidden-note">
                {{ unreachableCount() }} harmonically compatible track(s) hidden — they need
                more than ± {{ pitchRange() }}% pitch. Change the range in Settings.
              </div>
            }
            <label class="bpm-check">
              <input
                type="checkbox"
                [checked]="filters().pitchAdjust"
                (change)="onPitchAdjust($any($event.target).checked)"
              />
              account for key change from BPM sync (pitch)
            </label>
            @if (filters().pitchAdjust) {
              <div class="muted pitch-note">
                Keys below are the <b>pitched</b> keys after beat-matching to
                {{ track()!.bpm || '—' }} BPM — <b>not</b> the original keys.
                Half/double-tempo matching doesn't count as a pitch change.
              </div>
            }

            @if (active()) {
              <div style="margin-top:12px"><button class="btn" (click)="clear()">Clear filters</button></div>
            }
            }
          </div>

          <div class="panel bridge-panel">
            <div class="bridge-head">
              <b>Bridge finder</b>
              <span class="muted">
                I'm on this record and want to get to another — what takes me there?
              </span>
              <span class="spacer"></span>
              @if (bridgeTarget()) {
                <button class="btn" (click)="clearBridge()">Clear</button>
              }
            </div>

            <input
              type="text"
              placeholder="Search for the record you want to reach…"
              [value]="bridgeQuery()"
              (input)="bridgeQuery.set($any($event.target).value)"
            />

            @if (!bridgeTarget() && bridgeQuery().trim().length > 1) {
              <div class="bridge-options">
                @for (t of bridgeMatches(); track t.id) {
                  <div class="popover-item" (click)="pickBridge(t)">
                    @if (t.artwork) {
                      <img class="cover-sm" [src]="t.artwork" alt="" loading="lazy" referrerpolicy="no-referrer" />
                    } @else {
                      <span class="cover-sm cover-none" aria-hidden="true">♪</span>
                    }
                    <span class="track-title">{{ t.title }}</span>
                    <span class="track-artist">{{ t.artist }}</span>
                    @if (t.bpm) { <span class="bpm-badge">{{ t.bpm }} BPM</span> }
                    <span [class]="'key-badge ' + keyClass(t.camelot)">{{ t.keyText || 'no key' }}</span>
                  </div>
                } @empty {
                  <div class="muted" style="padding:8px">No records match that search.</div>
                }
              </div>
            }

            @if (bridgeTarget(); as target) {
              <div class="muted bridge-goal">
                Target: <b>{{ target.title }}</b> — {{ target.artist }}
                <span [class]="'key-badge ' + keyClass(target.camelot)">{{ target.keyText || 'no key' }}</span>
                @if (bridgeScope()) { <span>· searching within your crate selection</span> }
              </div>

              @if (bridges().length === 0) {
                <div class="empty">
                  No route found within {{ maxBridges }} record(s). Try widening the crate
                  selection, or raising the pitch range / set tempo drift in Settings.
                </div>
              } @else {
                <div class="muted bridge-goal">
                  Routes keep every deck inside ±{{ pitchRange() }}% and let the set tempo
                  drift at most ±{{ tempoDrift() }}% from {{ track()!.bpm || '—' }} BPM.
                  Keys shown are the keys each record <b>sounds in</b> at the tempo it is
                  played at.
                </div>
                @for (b of bridges(); track b.path[1] ? b.path[1].id + '-' + b.hops : b.hops) {
                  <div class="bridge-route">
                    <div class="bridge-route-head">
                      @if (b.hops === 0) {
                        <span class="rel-badge rel-same">direct mix</span>
                      } @else {
                        <span class="rel-badge rel-relative">via {{ b.hops }} record(s)</span>
                      }
                      <span class="muted">{{ routeTempoLabel(b) }}</span>
                      <span class="spacer"></span>
                      <span
                        class="pitch-badge"
                        [class.out]="b.maxPitch > pitchRange()"
                        title="The furthest any pitch fader has to travel on this route"
                      >max {{ stepPct(b.maxPitch) }}</span>
                    </div>
                    @for (r of b.records; track r.track.id; let i = $index) {
                      <div class="bridge-step" (click)="open(r.track)">
                        <span class="set-pos">{{ i + 1 }}</span>
                        <span class="track-title">{{ r.track.title }}</span>
                        <span class="track-artist">{{ r.track.artist }}</span>
                        @if (r.track.bpm) { <span class="bpm-badge">{{ r.track.bpm }} BPM</span> }
                        <span class="pitch-badge" [title]="faderTitle(r)">{{ faderLabel(r) }}</span>
                        @if (r.entryCamelot && r.entryCamelot !== r.track.camelot) {
                          <span
                            class="key-badge adjusted"
                            [title]="'Printed key: ' + (r.track.keyText || '—')"
                          >
                            {{ r.entryCamelot }}
                            <span class="pitch-tag">pitched</span>
                          </span>
                        } @else {
                          <span [class]="'key-badge ' + keyClass(r.track.camelot)">{{ r.track.keyText || 'no key' }}</span>
                        }
                      </div>
                      @if (b.steps[i]; as st) {
                        <div [class]="'transition ' + st.level">
                          <span class="tr-icon">↓</span>
                          <span class="tr-main">
                            {{ st.fromCamelot }} → {{ st.effectiveCamelot }}
                            @if (st.relation) { <span class="muted">({{ st.relation }})</span> }
                          </span>
                          <span class="bpm-badge">{{ mixTempoLabel(st) }}</span>
                          @if (st.percent !== null) {
                            <span class="pitch-badge" [class.out]="!st.reachable">{{ stepPct(st.percent) }}</span>
                          }
                        </div>
                      }
                    }
                  </div>
                }
              }
            }
          </div>

          @if (rows().length === 0) {
            <div class="panel empty">No mixable tracks match the current filters.</div>
          } @else {            <div class="panel mixable-list">
              @for (r of rows(); track r.track.id) {
                <div class="track-row" (click)="open(r.track)">
                  <span [class]="'rel-badge ' + relClass(r.camelot)">{{ rel(r.camelot) }}</span>
                  @if (r.track.artwork) {
                    <img class="cover" [src]="r.track.artwork" alt="" loading="lazy" referrerpolicy="no-referrer" />
                  } @else {
                    <span class="cover cover-none" aria-hidden="true">♪</span>
                  }
                  <span class="track-artist">{{ r.track.artist }}</span>
                  <span class="track-title">{{ r.track.title }}</span>
                  @if (r.track.position) {
                    <span class="pos-badge" title="Side and cut on the record">{{ r.track.position }}</span>
                  }
                  @if (r.track.bpm) { <span class="bpm-badge">{{ r.track.bpm }} BPM</span> }
                  <span
                    class="pitch-badge"
                    [class.out]="!r.reachable"
                    [class.unknown]="r.percent === null"
                    [title]="pitchTitle(r)"
                  >{{ pitchLabel(r) }}</span>
                  @if (r.adjusted) {
                    <span class="key-badge adjusted" [title]="'Original key: ' + (r.track.keyText || '—')">
                      {{ keyLabel(r) }}
                      <span class="pitch-tag">pitched {{ shiftLabel(r) }}</span>
                    </span>
                  } @else {
                    <span [class]="'key-badge ' + keyClass(r.track.camelot)">{{ r.track.keyText }}</span>
                  }
                </div>
              }
            </div>
          }
        }
      }
    </div>
  `,
})
export class TrackDetailComponent {
  readonly col = inject(CollectionService);
  readonly crateSvc = inject(CrateService);
  private readonly fs = inject(FilterStateService);
  private readonly config = inject(ConfigService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** Harmonic mixing reference card (modal), seeded with this track's key. */
  readonly showCheatsheet = signal(false);

  /** Microphone key/BPM detection (modal). */
  readonly showMic = signal(false);

  /** Turntable pitch range (± percent) from the settings. */
  readonly pitchRange = computed(() => {
    const r = Number(this.config.config().pitchRange);
    return Number.isFinite(r) && r > 0 ? r : 8;
  });

  /** How far a route may ride the set tempo from this record's own tempo (± %). */
  readonly tempoDrift = computed(() => {
    const d = Number(this.config.config().tempoDrift);
    return Number.isFinite(d) && d >= 0 ? d : this.pitchRange();
  });

  readonly filters = this.fs.detail;
  readonly active = computed(() => hasActiveFilters(this.filters()));

  /** Filters folded down to just the search box (remembered across reloads). */
  readonly collapsed = this.fs.detailCollapsed;
  readonly advancedCount = computed(() => activeFilterCount(this.filters(), 'detail'));

  toggleCollapsed(): void {
    this.fs.toggleCollapsed(this.collapsed);
  }

  private readonly params = toSignal(this.route.paramMap);

  readonly track = computed<Track | undefined>(() => {
    const id = Number(this.params()?.get('id'));
    return Number.isNaN(id) ? undefined : this.col.trackById(id);
  });

  readonly mixSet = computed(() => {
    const t = this.track();
    return t ? mixableCamelot(t.camelot) : [];
  });

  /** The current track's BPM as a number, or null if it has none. */
  readonly refBpm = computed<number | null>(() => {
    const raw = parseFloat(this.track()?.bpm ?? '');
    return Number.isNaN(raw) ? null : raw;
  });

  // --- Manual key/BPM editing ---
  readonly camelotOptions = CAMELOT_CODES;
  readonly editing = signal(false);
  readonly editCamelot = signal('');
  readonly editBpm = signal('');
  readonly saving = signal(false);
  readonly saveMsg = signal<string | null>(null);
  readonly saveErr = signal(false);

  /** Musical key name for a Camelot code, shown in the picker. */
  keyNameOf(code: string): string {
    return camelotToKeyName(code);
  }

  /**
   * Opens the editor with both fields pre-filled from the track, so correcting
   * one of them leaves the other exactly as it was. This matters: `save()`
   * writes key and BPM together, so a field that opened blank would silently
   * wipe the value it was supposed to preserve.
   */
  startEdit(): void {
    const t = this.track();
    if (!t) return;
    // Normalised so it matches an option value in the Camelot picker.
    this.editCamelot.set((t.camelot || '').trim().toUpperCase());
    this.editBpm.set((t.bpm || '').trim());
    this.saveMsg.set(null);
    this.saveErr.set(false);
    this.editing.set(true);
  }

  cancelEdit(): void {
    this.editing.set(false);
  }

  // --- doubling a half-time tempo ------------------------------------------

  /** The BPM being edited as a number, or null while it isn't one. */
  private readonly editBpmValue = computed(() => {
    const n = Number(this.editBpm().trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  });

  /** Only offered over a tempo that is actually there and would stay sane. */
  readonly canDoubleBpm = computed(() => {
    const n = this.editBpmValue();
    return n !== null && n * 2 <= 300;
  });

  readonly doubleBpmTitle = computed(() => {
    const n = this.editBpmValue();
    if (n === null) return 'Enter a BPM first';
    if (n * 2 > 300) return `${doubledText(n)} would be faster than any record`;
    return (
      `Double it to ${doubledText(n)} — catalogues often list a fast record at ` +
      `half its played tempo, which hides it from every beat-matched list`
    );
  });

  /**
   * Doubles the tempo in the editor (it is not saved until Save is pressed).
   *
   * Nothing else changes: the key is unaffected, because playing a record at
   * its true speed rather than mis-counting it does not transpose anything.
   */
  doubleBpm(): void {
    const n = this.editBpmValue();
    if (n === null) return;
    this.editBpm.set(doubledText(n));
  }

  /**
   * Which of this track's values were set by hand. Recomputed from the records
   * signal so it refreshes as soon as an edit is saved or released.
   */
  readonly manualLock = computed(() => {
    const t = this.track();
    this.col.records(); // establish the dependency
    return t ? this.col.manualLock(t) : { key: false, bpm: false };
  });

  /** "Key and BPM" / "Key" / "BPM", for the badge. */
  readonly manualLabel = computed(() => {
    const l = this.manualLock();
    return l.key && l.bpm ? 'Key and BPM' : l.key ? 'Key' : 'BPM';
  });

  readonly manualNote = computed(
    () =>
      `${this.manualLabel()} was corrected by hand, so the Beatport/tunebat ` +
      `passes leave it alone. The flag is saved in tracks.txt alongside the ` +
      `value, so it protects the correction on every device. Unlock to let the ` +
      `lookups fill it in again.`
  );

  /** Hands the track back to the automated lookups. */
  clearManual(): void {
    const t = this.track();
    if (!t) return;
    this.col.clearManual(t);
    this.saveErr.set(false);
    this.saveMsg.set(
      'Unlocked — the next Beatport/tunebat pass may update this track again.'
    );
  }

  /**
   * Opens the "listen to the record" analyser.
   *
   * Detection is offered from both the read-only row and the edit form, and in
   * both cases the result goes straight through `save()` — a value the user has
   * just confirmed against the record in front of them is a hand correction,
   * and gets the same protection from the automated passes as one typed in.
   */
  openMic(): void {
    this.saveMsg.set(null);
    this.saveErr.set(false);
    this.showMic.set(true);
  }

  /**
   * Writes the confirmed findings.
   *
   * Fields the user left un-ticked come back as null and keep whatever the
   * track already had: `save()` writes key and BPM together, so an unconfirmed
   * field must be carried over explicitly or it would be wiped.
   */
  async applyAnalysis(a: AnalysisApply): Promise<void> {
    const t = this.track();
    if (!t) return;
    this.showMic.set(false);
    this.editCamelot.set(a.camelot ?? (t.camelot || '').trim().toUpperCase());
    this.editBpm.set(a.bpm ?? (t.bpm || '').trim());
    await this.save();
  }

  /** Applies the edit locally, then commits tracks.txt to GitHub. */
  async save(): Promise<void> {
    const t = this.track();
    if (!t) return;
    const camelot = this.editCamelot().trim();
    const keyName = camelotToKeyName(camelot); // hardcoded from the chosen code
    const bpm = this.editBpm().trim();

    this.col.setTrackKeyBpm(t, keyName, camelot, bpm);
    this.editing.set(false);

    if (!this.col.canCommit()) {
      // Still queue it: once a repo and token are configured the change is
      // pushed on the next retry, instead of quietly staying on this device.
      this.col.markPending(`Edit ${t.title} — key/BPM`, 'GitHub is not configured.');
      this.saveErr.set(true);
      this.saveMsg.set('Saved locally. Configure a GitHub repo + token in ⚙ to persist.');
      return;
    }
    this.saving.set(true);
    this.saveMsg.set(null);
    this.saveErr.set(false);
    try {
      await this.col.commitToGithub(`Edit ${t.title} — key/BPM`);
      this.saveMsg.set('Saved to GitHub.');
      this.saveErr.set(false);
    } catch (e) {
      this.saveErr.set(true);
      // The change is queued and retried; the banner at the top of the page
      // carries it from here, so this message doesn't have to be the only
      // record of the failure.
      this.saveMsg.set('Saved locally — will retry GitHub automatically. (' + e + ')');
    } finally {
      this.saving.set(false);
    }
  }

  /** Computes a track's effective (optionally pitch-adjusted) key vs the current track. */
  private effectiveRow(x: Track): Row {
    const ref = this.refBpm();
    const cand = parseFloat(x.bpm);
    const hasBoth = ref !== null && !Number.isNaN(cand) && cand > 0;

    // The platter pitch is a physical fact, independent of whether the user
    // asked to see pitched keys, so it is always computed.
    const percent = hasBoth ? pitchPercent(cand, ref!) : null;
    const reachable = percent === null || withinPitchRange(percent, this.pitchRange());

    if (this.filters().pitchAdjust && hasBoth) {
      const semis = pitchShiftSemitones(cand, ref!);
      return {
        track: x,
        adjusted: true,
        semis,
        camelot: shiftCamelot(x.camelot, semis),
        keyName: shiftKeyName(x.keyName, semis),
        percent,
        reachable,
      };
    }
    return {
      track: x,
      adjusted: false,
      semis: 0,
      camelot: x.camelot,
      keyName: x.keyName,
      percent,
      reachable,
    };
  }

  /**
   * All mixable candidates (before facet filtering), excluding this track,
   * as rows carrying their effective key. Mixability is judged on the
   * effective (resulting) key, so with "account for key change" on, pitching
   * can move tracks in or out of the mixable set and relabel their type.
   */
  private readonly candidateRows = computed<Row[]>(() => {
    const t = this.track();
    if (!t || !t.camelot) return [];
    const set = new Set(this.mixSet());
    const rows = this.col
      .tracks()
      .filter((x) => x.id !== t.id && !!x.camelot)
      .map((x) => this.effectiveRow(x))
      .filter((r) => set.has(r.camelot));
    return rows.sort((a, b) => {
      const ra = REL_ORDER[relation(t.camelot, a.camelot)] ?? 99;
      const rb = REL_ORDER[relation(t.camelot, b.camelot)] ?? 99;
      return ra === rb ? a.track.title.localeCompare(b.track.title) : ra - rb;
    });
  });

  readonly optionGenres = computed(() =>
    unique(this.candidateRows().flatMap((r) => r.track.genres))
  );
  readonly optionStyles = computed(() =>
    unique(this.candidateRows().flatMap((r) => r.track.styles))
  );
  readonly optionKeys = computed(() =>
    unique(this.candidateRows().map((r) => r.camelot)).sort()
  );

  /** Distinct relationship types among the candidates, ordered by REL_ORDER. */
  readonly optionTypes = computed(() =>
    unique(this.candidateRows().map((r) => this.rel(r.camelot)))
      .sort((a, b) => (REL_ORDER[a] ?? 99) - (REL_ORDER[b] ?? 99))
  );

  /**
   * Visible rows after applying the facet + BPM filters. The key facet is
   * matched against each row's effective (resulting) key, and rows whose
   * relationship type is toggled off are excluded.
   */
  readonly rows = computed<Row[]>(() => {
    const f = this.filters();
    const hidden = new Set(f.hiddenTypes);
    const ref = this.refBpm() ?? undefined;
    const crates = this.crateSvc.crates();
    return this.candidateRows().filter(
      (r) =>
        matchesTrack(r.track, f, ref, r.camelot) &&
        inAnyCrate(crates, f.crates, r.track) &&
        !hidden.has(this.rel(r.camelot)) &&
        (!f.pitchLimit || r.reachable)
    );
  });
  readonly shown = computed(() => this.rows().length);

  /** How many mixable tracks the pitch-range filter is hiding. */
  readonly unreachableCount = computed(() => {
    const f = this.filters();
    const hidden = new Set(f.hiddenTypes);
    const ref = this.refBpm() ?? undefined;
    return this.candidateRows().filter(
      (r) =>
        !r.reachable &&
        matchesTrack(r.track, f, ref, r.camelot) &&
        !hidden.has(this.rel(r.camelot))
    ).length;
  });

  /** Signed pitch label for a row, e.g. "+2.4%" / "−3.1%" ("—" when unknown). */
  pitchLabel(r: Row): string {
    if (r.percent === null) return '—';
    const sign = r.percent >= 0 ? '+' : '−';
    return `${sign}${Math.abs(r.percent).toFixed(1)}%`;
  }

  /** Tooltip explaining what the pitch figure means for this transition. */
  pitchTitle(r: Row): string {
    if (r.percent === null) return 'BPM unknown — pitch cannot be calculated';
    const range = this.pitchRange();
    return r.reachable
      ? `Set the pitch fader to ${this.pitchLabel(r)} to beat-match (within ±${range}%)`
      : `Needs ${this.pitchLabel(r)} — beyond the ±${range}% your decks offer`;
  }

  /** Relationship label of an effective Camelot code vs the current track. */
  rel(camelot: string): string {
    const base = this.track();
    return base ? relation(base.camelot, camelot) : '';
  }

  /** Maps a relationship label to a CSS colour-group class for its badge. */
  relClass(camelot: string): string {
    const r = this.rel(camelot);
    switch (r) {
      case 'Same key': return 'rel-same';
      case 'Same root': return 'rel-root';
      case 'Relative': return 'rel-relative';
      case '+1 energy':
      case '-1 energy': return 'rel-energy';
      case 'Compatible': return 'rel-compatible';
    }
    if (r.includes('boost')) return 'rel-boost';
    if (r.includes('drop')) return 'rel-drop';
    return 'rel-compatible';
  }

  /** Displayed key text for an adjusted row, e.g. "A# minor (3A)". */
  keyLabel(r: Row): string {
    const name = r.keyName || '';
    return name ? `${name} (${r.camelot})` : r.camelot;
  }

  /** Camelot colour-group class (cam-1..cam-12) for a key badge / big key. */
  keyClass(camelot: string): string {
    return camelotClass(camelot);
  }

  /** Signed semitone shift label, e.g. "+0.21 st" / "−0.35 st". */
  shiftLabel(r: Row): string {
    const sign = r.semis >= 0 ? '+' : '−';
    return `${sign}${Math.abs(r.semis).toFixed(2)} st`;
  }

  onSearch(value: string): void {
    this.fs.setSearch(this.filters, value);
  }

  onBpmRange(value: string): void {
    this.fs.setBpmRange(this.filters, parseFloat(value));
  }

  onBpmEnabled(checked: boolean): void {
    this.fs.setBpmEnabled(this.filters, checked);
  }

  onBpmDoubleHalf(checked: boolean): void {
    this.fs.setBpmDoubleHalf(this.filters, checked);
  }

  onPitchAdjust(checked: boolean): void {
    this.fs.setPitchAdjust(this.filters, checked);
  }

  onPitchLimit(checked: boolean): void {
    this.fs.setPitchLimit(this.filters, checked);
  }

  toggle(facet: 'genres' | 'styles' | 'keys' | 'crates', value: string): void {
    this.fs.toggle(this.filters, facet, value);
  }

  /** Turns off every crate chip, i.e. mix from the whole collection again. */
  clearCrates(): void {
    this.fs.setCrates(this.filters, []);
  }

  toggleType(type: string): void {
    this.fs.toggleType(this.filters, type);
  }

  clear(): void {
    this.fs.clear(this.filters);
  }

  open(t: Track): void {
    this.router.navigate(['/track', t.id]);
  }

  // --- Bridge finder ------------------------------------------------------

  /** Cap on inserted records; 2 keeps the search fast and the answer usable. */
  readonly maxBridges = 2;

  readonly bridgeQuery = signal('');
  readonly bridgeTarget = signal<Track | null>(null);

  /** True when a crate filter is narrowing the pool of usable records. */
  readonly bridgeScope = computed(() => this.filters().crates.length > 0);

  /**
   * Records available to route through: the crate selection when there is one,
   * since a bridge via a record you left at home is no use.
   */
  private readonly bridgePool = computed<Track[]>(() => {
    const f = this.filters();
    const crates = this.crateSvc.crates();
    return this.col.tracks().filter((t) => inAnyCrate(crates, f.crates, t));
  });

  readonly bridgeMatches = computed<Track[]>(() => {
    const q = this.bridgeQuery().trim().toLowerCase();
    if (q.length < 2) return [];
    const cur = this.track();
    return this.col
      .tracks()
      .filter(
        (t) =>
          t.id !== cur?.id &&
          !!t.camelot &&
          (t.title + ' ' + t.artist + ' ' + t.recordTitle).toLowerCase().includes(q)
      )
      .slice(0, 8);
  });

  readonly bridges = computed<Bridge[]>(() => {
    const from = this.track();
    const to = this.bridgeTarget();
    if (!from || !to) return [];
    return findBridges(from, to, this.bridgePool(), {
      pitchRange: this.pitchRange(),
      tempoDrift: this.tempoDrift(),
      maxBridges: this.maxBridges,
      limit: 5,
    });
  });

  pickBridge(t: Track): void {
    this.bridgeTarget.set(t);
    this.bridgeQuery.set(`${t.title} — ${t.artist}`);
  }

  clearBridge(): void {
    this.bridgeTarget.set(null);
    this.bridgeQuery.set('');
  }

  stepPct(percent: number): string {
    return formatPercent(percent);
  }

  /** Where the set tempo starts and ends on a route, e.g. "126 → 131 BPM (+4.3%)". */
  routeTempoLabel(b: Bridge): string {
    if (b.startTempo === null || b.endTempo === null) return 'tempo unknown';
    if (Math.abs(b.tempoShift) < 0.05) return `holds ${b.startTempo.toFixed(1)} BPM`;
    return (
      `${b.startTempo.toFixed(1)} → ${b.endTempo.toFixed(1)} BPM ` +
      `(${formatPercent(b.tempoShift)})`
    );
  }

  /** The tempo a blend happens at, e.g. "@ 128.4 BPM". */
  mixTempoLabel(st: Transition): string {
    return st.mixTempo === null ? '@ ? BPM' : `@ ${st.mixTempo.toFixed(1)} BPM`;
  }

  /** Fader position a record is brought in at, e.g. "+2.4%". */
  faderLabel(r: RouteRecord): string {
    return r.entryPitch === null ? '—' : formatPercent(r.entryPitch);
  }

  /** Explains a record's fader position, including any ride before it goes out. */
  faderTitle(r: RouteRecord): string {
    if (r.entryPitch === null || r.exitPitch === null) return 'BPM unknown — pitch cannot be calculated';
    const enter = `Comes in at ${formatPercent(r.entryPitch)}`;
    const key =
      r.entryCamelot && r.entryCamelot !== r.track.camelot
        ? `, sounding in ${r.entryCamelot} rather than ${r.track.camelot}`
        : '';
    if (Math.abs(r.exitPitch - r.entryPitch) < 0.05) return `${enter}${key}.`;
    return `${enter}${key}; ride it to ${formatPercent(r.exitPitch)} before the next mix.`;
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => !!v))).sort((a, b) => a.localeCompare(b));
}

