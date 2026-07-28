import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { CollectionService } from './collection.service';
import { FilterStateService, activeFilterCount, hasActiveFilters } from './filter-state.service';
import { matchesTrack } from './filtering';
import { camelotClass } from './camelot';
import { Rec, Track } from './models';
import { UpdaterService, TrackChange } from './updater.service';
import { ConfigService } from './config.service';

/** A record together with the tracks that survived the current filters. */
interface Row {
  record: Rec;
  tracks: Track[];
  /** How many of the record's tracks the filters are hiding (0 = all shown). */
  hidden: number;
}

interface Popover {
  x: number;
  y: number;
  record: Rec;
  tracks: Track[];
  hidden: number;
}

@Component({
  selector: 'app-records-list',
  standalone: true,
  template: `
    <div class="topbar">
      <h1>🎵 Vinyl Collection</h1>
      <span class="spacer"></span>
      <span class="badge-count">{{ shownTracks() }} / {{ totalTracks() }} tracks</span>
      <button
        class="btn primary"
        [disabled]="updater.running()"
        [title]="updateTooltip()"
        (click)="update()"
      >
        {{ updater.running() ? 'Updating…' : '⟳ Update collection' }}
      </button>
      <button
        class="btn"
        [disabled]="updater.running()"
        title="Ask tunebat again for every track's key + BPM and correct the wrong ones (ignores the local cache)"
        (click)="refetch()"
      >
        ↻ Re-fetch keys / BPM
      </button>
      <button class="btn" title="Settings (Discogs / GitHub)" (click)="toggleSettings()">⚙</button>
    </div>

    <div class="container">
      @if (updater.running() || updater.message()) {
        <div class="panel update-status">
          @if (updater.running()) {
            <div class="progress"><span class="bar" [style.width.%]="progressPct()"></span></div>
            <span class="badge-count">{{ updater.processed() }} / {{ updater.total() }}</span>
            @if (updater.corrected()) {
              <span class="badge-count corrected-count">{{ updater.corrected() }} corrected</span>
            }
          }
          <span class="muted">{{ updater.message() }}</span>
          @if (updater.error(); as e) { <span class="err"> — {{ e }}</span> }
          @if (updater.running()) {
            <span class="spacer"></span>
            <button
              class="btn danger"
              [disabled]="updater.cancelling()"
              title="Stop the running job — anything already done is saved"
              (click)="updater.cancel()"
            >
              {{ updater.cancelling() ? 'Stopping…' : '✕ Cancel' }}
            </button>
          }
        </div>
      }

      @if (showSettings()) {
        <div class="panel settings">
          <div class="settings-grid">
            <label>Discogs user</label>
            <input [value]="cfg().discogsUser" (input)="set('discogsUser', $any($event.target).value)" />
            <label>Discogs token <span class="muted">(optional)</span></label>
            <input type="password" [value]="cfg().discogsToken" (input)="set('discogsToken', $any($event.target).value)" />
            <label>GitHub owner</label>
            <input [value]="cfg().githubOwner" (input)="set('githubOwner', $any($event.target).value)" />
            <label>GitHub repo</label>
            <input [value]="cfg().githubRepo" (input)="set('githubRepo', $any($event.target).value)" />
            <label>Branch</label>
            <input [value]="cfg().githubBranch" (input)="set('githubBranch', $any($event.target).value)" />
            <label>tracks.txt path</label>
            <input [value]="cfg().tracksPath" (input)="set('tracksPath', $any($event.target).value)" />
            <label>GitHub token <span class="muted">(contents:write)</span></label>
            <input type="password" [value]="cfg().githubToken" (input)="set('githubToken', $any($event.target).value)" />
            <label>CORS proxy for tunebat <span class="muted">(prefix)</span></label>
            <input placeholder="e.g. https://api.allorigins.win/raw?url=" [value]="cfg().corsProxy" (input)="set('corsProxy', $any($event.target).value)" />
          </div>
          <div class="muted settings-help">
            Tokens are stored only in your browser (localStorage). The GitHub token needs
            write access to the repo above so updates can be saved to <b>{{ cfg().tracksPath }}</b>.
          </div>
        </div>
      }
      @if (col.error(); as err) {
        <div class="panel empty">{{ err }}</div>
      } @else if (!col.loaded()) {
        <div class="panel empty">Loading collection…</div>
      } @else {
        <div class="panel filters">
          <div class="filters-head">
            <div class="filters-search">
              <label for="list-search">Search</label>
              <input
                id="list-search"
                type="text"
                placeholder="Search title, artist, key, record, label, year…"
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
            <label>Genres</label>
            <div class="chips">
              @for (g of col.allGenres(); track g) {
                <span class="chip" [class.active]="filters().genres.includes(g)" (click)="toggle('genres', g)">{{ g }}</span>
              }
            </div>

            <label>Styles</label>
            <div class="chips">
              @for (s of col.allStyles(); track s) {
                <span class="chip" [class.active]="filters().styles.includes(s)" (click)="toggle('styles', s)">{{ s }}</span>
              }
            </div>

            <label>Keys (Camelot)</label>
            <div class="chips">
              @for (k of col.allCamelot(); track k) {
                <span class="chip" [class.active]="filters().keys.includes(k)" (click)="toggle('keys', k)">{{ k }}</span>
              }
            </div>

            <label>Release year</label>
            <div class="year-filter">
              <input
                class="year-input"
                type="number"
                [placeholder]="minYear() ? 'from ' + minYear() : 'from'"
                [value]="filters().yearMin ?? ''"
                (input)="onYearMin($any($event.target).value)"
              />
              <span class="muted">–</span>
              <input
                class="year-input"
                type="number"
                [placeholder]="maxYear() ? 'to ' + maxYear() : 'to'"
                [value]="filters().yearMax ?? ''"
                (input)="onYearMax($any($event.target).value)"
              />
            </div>

            @if (active()) {
              <div style="margin-top:12px">
                <button class="btn" (click)="clear()">Clear filters</button>
              </div>
            }
          }
        </div>

        <div class="panel view-controls">
          <label class="switch">
            <input
              type="checkbox"
              [checked]="view().showTracks"
              (change)="setShowTracks($any($event.target).checked)"
            />
            <span>Show tracks</span>
          </label>

          @if (!view().showTracks) {
            <span class="spacer"></span>
            <span class="muted" style="font-size:12px">Layout</span>
            <div class="seg">
              <button class="btn" [class.active]="view().layout === 'list'" (click)="setLayout('list')">☰ List</button>
              <button class="btn" [class.active]="view().layout === 'grid'" (click)="setLayout('grid')">▦ Grid</button>
            </div>
          }
        </div>

        @if (filtered().length === 0) {
          <div class="panel empty">No tracks match the current filters.</div>
        }

        @if (view().showTracks) {
          @for (row of filtered(); track row.record.title + row.record.artist) {
            <div class="panel record">
              <div class="record-head-row">
                @if (row.record.artwork) {
                  <img class="cover" [src]="row.record.artwork" alt="" loading="lazy" referrerpolicy="no-referrer" />
                }
                <div>
                  <div class="record-head">
                    <span class="record-title">{{ row.record.title }}</span>
                    <span class="record-artist">— {{ row.record.artist }}</span>
                  </div>
                  @if (recordMeta(row.record); as meta) {
                    <div class="record-meta muted">{{ meta }}</div>
                  }
                  <div class="tags">
                    @for (g of row.record.genres; track g) { <span class="tag">{{ g }}</span> }
                    @for (s of row.record.styles; track s) { <span class="tag">{{ s }}</span> }
                  </div>
                </div>
              </div>
              <div style="margin-top:8px">
                @for (t of row.tracks; track t.id) {
                  <div class="track-row" (click)="open(t)">
                    <span class="track-title">{{ t.title }}</span>
                    <span class="track-artist">{{ t.artist }}</span>
                    @if (t.bpm) { <span class="bpm-badge">{{ t.bpm }} BPM</span> }
                    <span [class]="keyBadgeClass(t)">{{ t.keyText || 'no key' }}</span>
                  </div>
                }
                @if (row.hidden) {
                  <div class="hidden-note muted" [title]="hiddenTitle(row)">
                    {{ hiddenLabel(row) }}
                  </div>
                }
              </div>
            </div>
          }
        } @else {
          <div [class]="view().layout === 'grid' ? 'rec-cards grid' : 'rec-cards list'">
            @for (row of filtered(); track row.record.title + row.record.artist) {
              <div class="rec-card clickable" (click)="openRecord($event, row)">
                @if (row.record.artwork) {
                  <img class="cover" [src]="row.record.artwork" alt="" loading="lazy" referrerpolicy="no-referrer" />
                }
                <div class="rec-card-body">
                  <div class="record-title">{{ row.record.title }}</div>
                  <div class="record-artist">{{ row.record.artist }}</div>
                  @if (recordMeta(row.record); as meta) {
                    <div class="record-meta muted">{{ meta }}</div>
                  }
                  <div class="tags">
                    @for (g of row.record.genres; track g) { <span class="tag">{{ g }}</span> }
                    @for (s of row.record.styles; track s) { <span class="tag">{{ s }}</span> }
                  </div>
                </div>
              </div>
            }
          </div>
        }

        @if (popover(); as pop) {
          <div class="popover-backdrop" (click)="closePopover()"></div>
          <div
            class="popover"
            #popEl
            [style.left.px]="pop.x"
            [style.top.px]="pop.y"
            (click)="$event.stopPropagation()"
          >
            <div class="popover-head">
              <span class="record-title">{{ pop.record.title }}</span>
              <span class="record-artist">— {{ pop.record.artist }}</span>
            </div>
            @if (recordMeta(pop.record); as meta) {
              <div class="record-meta muted" style="padding:0 2px 6px">{{ meta }}</div>
            }
            @if (pop.tracks.length === 0) {
              <div class="popover-empty muted">No tracks for this record.</div>
            } @else {
              @for (t of pop.tracks; track t.id) {
                <div class="popover-item" (click)="open(t)">
                  <span class="track-title">{{ t.title }}</span>
                  @if (t.bpm) { <span class="bpm-badge">{{ t.bpm }} BPM</span> }
                  <span [class]="keyBadgeClass(t)">{{ t.keyText || 'no key' }}</span>
                </div>
              }
              @if (pop.hidden) {
                <div class="hidden-note muted" [title]="hiddenTitle(pop)">
                  {{ hiddenLabel(pop) }}
                </div>
              }
            }
          </div>
        }
      }

      @if (updater.reportReady()) {
        <div class="modal-backdrop" (click)="closeReport()">
          <div class="modal" (click)="$event.stopPropagation()">
            <div class="modal-head">
              <h2>Re-fetch report</h2>
              <span class="spacer"></span>
              <button class="btn" (click)="closeReport()">✕</button>
            </div>

            <div class="muted modal-sub">
              Checked {{ updater.processed() }} of {{ updater.total() }} tracks —
              <b>{{ updater.changes().length }}</b> updated.
              @if (updater.processed() < updater.total()) {
                <span> (stopped early — the rest were left untouched)</span>
              }
            </div>

            @if (updater.changes().length === 0) {
              <div class="empty">No corrections were made — nothing was changed.</div>
            } @else {
              <div class="modal-body">
                @for (c of updater.changes(); track c.trackId) {
                  <div class="change-row" (click)="openChange(c)">
                    <div class="change-track">
                      <div class="track-title">{{ c.title }}</div>
                      <div class="muted">{{ c.artist }} · {{ c.recordTitle }}</div>
                    </div>
                    <div class="change-values">
                      @if (c.keyChanged) {
                        <div class="change-line">
                          <span class="key-badge old">{{ c.oldKeyText || 'no key' }}</span>
                          <span class="muted">→</span>
                          <span [class]="'key-badge ' + keyClass(c.newKeyText)">{{ c.newKeyText }}</span>
                        </div>
                      }
                      @if (c.bpmChanged) {
                        <div class="change-line">
                          <span class="bpm-badge old">{{ c.oldBpm || 'no BPM' }}</span>
                          <span class="muted">→</span>
                          <span class="bpm-badge">{{ c.newBpm }} BPM</span>
                        </div>
                      }
                    </div>
                  </div>
                }
              </div>
            }

            <div class="modal-foot">
              <span class="muted">{{ updater.message() }}</span>
              <span class="spacer"></span>
              <button class="btn primary" (click)="closeReport()">Close</button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
})
export class RecordsListComponent {
  readonly col = inject(CollectionService);
  readonly updater = inject(UpdaterService);
  private readonly config = inject(ConfigService);
  private readonly fs = inject(FilterStateService);
  private readonly router = inject(Router);

  readonly filters = this.fs.list;
  readonly active = computed(() => hasActiveFilters(this.filters()));
  readonly view = this.fs.view;

  /** Filters folded down to just the search box (remembered across reloads). */
  readonly collapsed = this.fs.listCollapsed;
  readonly advancedCount = computed(() => activeFilterCount(this.filters(), 'list'));

  readonly cfg = this.config.config;
  readonly showSettings = signal(false);

  /** Hover text: progress while running, otherwise the missing key/BPM counts. */
  readonly updateTooltip = computed(() => {
    const mk = this.updater.missingKeys();
    const mb = this.updater.missingBpm();
    if (this.updater.running()) {
      return `Updating… ${this.updater.processed()}/${this.updater.total()} records · ${mk} keys, ${mb} BPM still missing`;
    }
    return `Fetch the Discogs collection and fill missing data · ${mk} keys, ${mb} BPM missing`;
  });

  readonly progressPct = computed(() => {
    const t = this.updater.total();
    return t > 0 ? Math.round((this.updater.processed() / t) * 100) : 0;
  });

  /** Record popover shown near the pointer when a compact card is clicked. */
  readonly popover = signal<Popover | null>(null);
  private readonly popEl = viewChild<ElementRef<HTMLDivElement>>('popEl');

  constructor() {
    // Once the popover is rendered, measure its real size and re-clamp so it
    // never gets clipped by a screen edge (the open-time value is an estimate).
    // allowSignalWrites: the effect updates the popover position signal, which
    // converges in one extra pass thanks to the change guard below.
    effect(
      () => {
        const pop = this.popover();
        const el = this.popEl()?.nativeElement;
        if (!pop || !el) return;
        const { width, height } = el.getBoundingClientRect();
        if (width === 0 || height === 0) return; // not laid out yet
        const { x, y } = this.clampToViewport(pop.x, pop.y, width, height);
        if (x !== pop.x || y !== pop.y) {
          this.popover.set({ ...pop, x, y }); // converges in one extra pass
        }
      },
      { allowSignalWrites: true }
    );
  }

  readonly filtered = computed<Row[]>(() => {
    const f = this.filters();
    const out: Row[] = [];
    for (const r of this.col.records()) {
      const tracks = r.tracks.filter((t) => matchesTrack(t, f));
      if (tracks.length) out.push({ record: r, tracks, hidden: r.tracks.length - tracks.length });
    }
    return out;
  });

  readonly totalTracks = computed(() => this.col.tracks().length);
  readonly shownTracks = computed(() =>
    this.filtered().reduce((n, row) => n + row.tracks.length, 0)
  );

  /** Earliest / latest known release year across the collection (0 if none). */
  readonly minYear = computed(() => {
    const ys = this.col.records().map((r) => r.year).filter((y) => y > 0);
    return ys.length ? Math.min(...ys) : 0;
  });
  readonly maxYear = computed(() => {
    const ys = this.col.records().map((r) => r.year).filter((y) => y > 0);
    return ys.length ? Math.max(...ys) : 0;
  });

  /** "1997 · Transient Records" style meta line (empty when nothing to show). */
  recordMeta(r: Rec): string {
    const parts: string[] = [];
    if (r.year) parts.push(String(r.year));
    if (r.labels.length) parts.push(r.labels.join(', '));
    return parts.join(' · ');
  }

  /** Key badge classes incl. the Camelot colour group (or "none" when absent). */
  keyBadgeClass(t: Track): string {
    return t.keyText ? 'key-badge ' + camelotClass(t.camelot) : 'key-badge none';
  }

  /** "+ 3 more tracks hidden by filters" note shown under a partial tracklist. */
  hiddenLabel(row: { hidden: number }): string {
    return `+ ${row.hidden} more ${row.hidden === 1 ? 'track' : 'tracks'} hidden by filters`;
  }

  hiddenTitle(row: { record: Rec; tracks: Track[] }): string {
    return `${row.tracks.length} of ${row.record.tracks.length} tracks match the current filters`;
  }

  onSearch(value: string): void {
    this.fs.setSearch(this.filters, value);
  }

  onYearMin(value: string): void {
    const y = parseInt(value, 10);
    this.fs.setYearMin(this.filters, Number.isNaN(y) ? null : y);
  }

  onYearMax(value: string): void {
    const y = parseInt(value, 10);
    this.fs.setYearMax(this.filters, Number.isNaN(y) ? null : y);
  }

  toggle(facet: 'genres' | 'styles' | 'keys', value: string): void {
    this.fs.toggle(this.filters, facet, value);
  }

  clear(): void {
    this.fs.clear(this.filters);
  }

  toggleCollapsed(): void {
    this.fs.toggleCollapsed(this.collapsed);
  }

  setShowTracks(showTracks: boolean): void {
    this.view.set({ ...this.view(), showTracks });
    this.closePopover();
  }

  setLayout(layout: 'list' | 'grid'): void {
    this.view.set({ ...this.view(), layout });
  }

  /** Opens the track popover next to the pointer, clamped to the viewport. */
  openRecord(ev: MouseEvent, row: Row): void {
    ev.stopPropagation();
    // Initial estimate matching the CSS (width 300, max-height 60vh); the
    // measure effect below refines this exactly once the popover has rendered.
    const w = 300;
    const estH = 80 + row.tracks.length * 40 + (row.hidden ? 28 : 0);
    const h = Math.min(estH, Math.round(window.innerHeight * 0.6));
    const pos = this.clampToViewport(ev.clientX + 4, ev.clientY + 4, w, h);
    this.popover.set({ x: pos.x, y: pos.y, record: row.record, tracks: row.tracks, hidden: row.hidden });
  }

  /** Clamps a top-left point so a box of w×h stays within the viewport (8px gutter). */
  private clampToViewport(x: number, y: number, w: number, h: number): { x: number; y: number } {
    return {
      x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    };
  }

  closePopover(): void {
    this.popover.set(null);
  }

  open(t: Track): void {
    this.closePopover();
    this.router.navigate(['/track', t.id]);
  }

  update(): void {
    void this.updater.start();
  }

  /** Re-asks tunebat for every track's key/BPM and corrects the wrong ones. */
  refetch(): void {
    const n = this.totalTracks();
    const ok = confirm(
      `Re-check all ${n} tracks against tunebat?\n\n` +
        `This ignores the local cache and overwrites any key/BPM that comes back ` +
        `different. It takes roughly ${Math.ceil((n * 0.5) / 60)} minute(s).`
    );
    if (ok) void this.updater.refetchAll();
  }

  closeReport(): void {
    this.updater.dismissReport();
  }

  /** Camelot colour class for a "A minor (8A)" style key text. */
  keyClass(keyText: string): string {
    const m = /\((\d{1,2}[AB])\)/.exec(keyText || '');
    return m ? camelotClass(m[1]) : '';
  }

  /** Jumps to a corrected track's detail page from the report. */
  openChange(c: TrackChange): void {
    this.closeReport();
    this.router.navigate(['/track', c.trackId]);
  }

  toggleSettings(): void {
    this.showSettings.update((v) => !v);
  }

  set(field: keyof ReturnType<ConfigService['config']>, value: string): void {
    this.config.update({ [field]: value } as any);
  }
}

