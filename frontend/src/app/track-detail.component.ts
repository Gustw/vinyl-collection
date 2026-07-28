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
  imports: [RouterLink],
  template: `
    <div class="topbar">
      <a routerLink="/" class="btn">← Back to list</a>
      <h1 style="margin-left:8px">Track detail</h1>
      <span class="spacer"></span>
      @if (track()) {
        <span class="badge-count">{{ shown() }} mixable track(s)</span>
      }
    </div>

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
            }
            <div style="flex:1">
              <div [class]="'big-key ' + keyClass(track()!.camelot)">{{ track()!.keyText || 'No key detected' }}</div>
              <div style="height:10px"></div>
              <div class="detail-grid">
                <div class="k">Title</div><div>{{ track()!.title }}</div>
                <div class="k">Artist</div><div>{{ track()!.artist }}</div>
                <div class="k">Record</div><div>{{ track()!.recordTitle }} — {{ track()!.recordArtist }}</div>
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
                    <select class="ef-select" [value]="editCamelot()" (change)="editCamelot.set($any($event.target).value)">
                      <option value="">— none —</option>
                      @for (c of camelotOptions; track c) {
                        <option [value]="c">{{ c }} — {{ keyNameOf(c) }}</option>
                      }
                    </select>
                  </div>
                  <div class="ef-field">
                    <label>BPM</label>
                    <input
                      class="ef-input"
                      type="number"
                      min="0"
                      step="1"
                      placeholder="e.g. 128"
                      [value]="editBpm()"
                      (input)="editBpm.set($any($event.target).value)"
                    />
                  </div>
                  <div class="edit-actions">
                    <button class="btn primary" [disabled]="saving()" (click)="save()">
                      {{ saving() ? 'Saving…' : 'Save' }}
                    </button>
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
                    (click)="toggle('crates', c.id)"
                  >{{ c.name }} <span class="chip-count">{{ c.trackKeys.length }}</span></span>
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

          @if (rows().length === 0) {
            <div class="panel empty">No mixable tracks match the current filters.</div>
          } @else {
            <div class="panel">
              @for (r of rows(); track r.track.id) {
                <div class="track-row" (click)="open(r.track)">
                  <span [class]="'rel-badge ' + relClass(r.camelot)">{{ rel(r.camelot) }}</span>
                  @if (r.track.artwork) {
                    <img class="cover" [src]="r.track.artwork" alt="" loading="lazy" referrerpolicy="no-referrer" />
                  }
                  <span class="track-title">{{ r.track.title }}</span>
                  <span class="track-artist">{{ r.track.artist }}</span>
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

  /** Turntable pitch range (± percent) from the settings. */
  readonly pitchRange = computed(() => {
    const r = Number(this.config.config().pitchRange);
    return Number.isFinite(r) && r > 0 ? r : 8;
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

  startEdit(): void {
    const t = this.track();
    if (!t) return;
    this.editCamelot.set(t.camelot);
    this.editBpm.set(t.bpm);
    this.saveMsg.set(null);
    this.saveErr.set(false);
    this.editing.set(true);
  }

  cancelEdit(): void {
    this.editing.set(false);
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
      this.saveMsg.set('Saved locally, but GitHub commit failed: ' + e);
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

  toggleType(type: string): void {
    this.fs.toggleType(this.filters, type);
  }

  clear(): void {
    this.fs.clear(this.filters);
  }

  open(t: Track): void {
    this.router.navigate(['/track', t.id]);
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => !!v))).sort((a, b) => a.localeCompare(b));
}

