import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CollectionService } from './collection.service';
import { CrateService, inAnyCrate } from './crate.service';
import { FilterStateService, activeFilterCount, hasActiveFilters } from './filter-state.service';
import { matchesTrack } from './filtering';
import { camelotClass } from './camelot';
import { Rec, Track } from './models';
import { UpdaterService, TrackChange } from './updater.service';
import { ConfigService } from './config.service';

/** A record together with the tracks that survived the current filters. */
interface Row {  record: Rec;
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

/** Compact duration for progress badges: "2h 5m", "3m 20s", "45s". */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

@Component({
  selector: 'app-records-list',
  standalone: true,
  imports: [RouterLink],
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
      <button class="btn" title="Manage crates" (click)="openCrates()">🗃 Crates</button>
      <a class="btn" routerLink="/set" title="Build a set from a crate and check every transition">▶ Set builder</a>
      <button class="btn" title="Settings (Discogs / GitHub)" (click)="toggleSettings()">⚙</button>
    </div>

    <div class="container">
      @if (updater.running() || updater.message()) {
        <div class="panel update-status">
          @if (updater.running()) {
            <div class="progress"><span class="bar" [style.width.%]="progressPct()"></span></div>
            <span class="badge-count">{{ updater.processed() }} / {{ updater.total() }}</span>
            @if (updater.etaMs() !== null) {
              <span class="badge-count" title="Estimated from the pace so far, including any time lost to rate limiting">
                ~{{ etaLabel() }} left
              </span>
            }
            @if (updater.rateLimitedMs() > 0) {
              <span class="badge-count throttled-count" title="Time this run has spent waiting out tunebat rate limits">
                ⏳ {{ throttledLabel() }} rate limited
              </span>
            }
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
            <label>Turntable pitch range <span class="muted">(± %)</span></label>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              placeholder="8"
              [value]="cfg().pitchRange"
              (input)="setPitchRange($any($event.target).value)"
            />
          </div>
          <div class="muted settings-help">
            Tokens are stored only in your browser (localStorage). The GitHub token needs
            write access to the repo above so updates can be saved to <b>{{ cfg().tracksPath }}</b>.
            The pitch range decides which mixes count as reachable — 8 for a stock Technics,
            16 for wide-range mode, 50 for most digital decks.
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
            @if (crateSvc.crates().length) {
              <label>Crates</label>
              <div class="chips">
                @for (c of crateSvc.crates(); track c.id) {
                  <span
                    class="chip"
                    [class.active]="filters().crates.includes(c.id)"
                    [title]="filters().crates.includes(c.id) ? 'Click to stop filtering on ' + c.name : 'Click to also show ' + c.name"
                    (click)="toggle('crates', c.id)"
                  >🗃 {{ c.name }} <span class="chip-count">{{ c.trackKeys.length }}</span></span>
                }
                @if (filters().crates.length) {
                  <span class="chip ghost" (click)="clearCrates()">✕ show all</span>
                }
              </div>
            }

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
                <div class="popover-item">
                  <span class="track-title" (click)="open(t)">{{ t.title }}</span>
                  @if (t.bpm) { <span class="bpm-badge">{{ t.bpm }} BPM</span> }
                  <span [class]="keyBadgeClass(t)" (click)="open(t)">{{ t.keyText || 'no key' }}</span>
                  <button
                    class="crate-btn"
                    [class.on]="crateSvc.cratesOf(t).length"
                    [title]="crateTitle(t)"
                    (click)="openCratePicker($event, t)"
                  >🗃</button>
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

      @if (cratePicker(); as cp) {
        <div class="popover-backdrop" (click)="closeCratePicker()"></div>
        <div
          class="popover crate-picker"
          [style.left.px]="cp.x"
          [style.top.px]="cp.y"
          (click)="$event.stopPropagation()"
        >
          <div class="popover-head">
            <span class="record-title">Add to crate</span>
            <span class="muted">{{ cp.track.title }}</span>
          </div>
          @if (crateSvc.crates().length === 0) {
            <div class="popover-empty muted">No crates yet — create one below.</div>
          } @else {
            @for (c of crateSvc.crates(); track c.id) {
              <label class="popover-item crate-pick">
                <input
                  type="checkbox"
                  [checked]="crateSvc.contains(c.id, cp.track)"
                  (change)="crateSvc.toggle(c.id, cp.track)"
                />
                <span class="track-title">{{ c.name }}</span>
                <span class="muted">{{ c.trackKeys.length }}</span>
              </label>
            }
          }
          <div class="crate-new">
            <input
              type="text"
              placeholder="New crate name…"
              [value]="newCrateName()"
              (input)="newCrateName.set($any($event.target).value)"
              (keydown.enter)="createCrateWith(cp.track)"
            />
            <button class="btn" [disabled]="!newCrateName().trim()" (click)="createCrateWith(cp.track)">Add</button>
          </div>
        </div>
      }

      @if (showCrates()) {
        <div class="modal-backdrop" (click)="closeCrates()">
          <div class="modal" (click)="$event.stopPropagation()">
            <div class="modal-head">
              <h2>Crates</h2>
              <span class="spacer"></span>
              <button class="btn" (click)="closeCrates()">✕</button>
            </div>
            <div class="muted modal-sub">
              A crate is the box you actually carry to a gig. Crates are saved to
              <b>{{ cfg().cratesPath }}</b> in your repo.
            </div>

            <div class="modal-body">
              @if (crateSvc.crates().length === 0) {
                <div class="empty">No crates yet.</div>
              } @else {
                @for (c of crateSvc.crates(); track c.id) {
                  <div class="crate-row">
                    <input
                      class="crate-name"
                      type="text"
                      [value]="c.name"
                      (change)="crateSvc.rename(c.id, $any($event.target).value)"
                    />
                    <span class="badge-count">{{ c.trackKeys.length }} track(s)</span>
                    @if (crateSvc.missingCount(c.id); as miss) {
                      <span class="badge-count err" [title]="'Tracks in this crate that are no longer in the collection'">
                        {{ miss }} missing
                      </span>
                    }
                    <span class="spacer"></span>
                    <button
                      class="btn"
                      [class.active]="filters().crates.includes(c.id)"
                      (click)="toggle('crates', c.id)"
                    >
                      {{ filters().crates.includes(c.id) ? '✓ Shown' : 'Show' }}
                    </button>
                    <button class="btn danger" (click)="deleteCrate(c.id, c.name)">Delete</button>
                  </div>
                }
              }
            </div>

            <div class="modal-foot">
              <input
                class="crate-name"
                type="text"
                placeholder="New crate name…"
                [value]="newCrateName()"
                (input)="newCrateName.set($any($event.target).value)"
                (keydown.enter)="createCrate()"
              />
              <button class="btn primary" [disabled]="!newCrateName().trim()" (click)="createCrate()">
                Create crate
              </button>
              <span class="spacer"></span>
              @if (crateSvc.error()) {
                <span class="err">{{ crateSvc.error() }}</span>
              } @else if (crateSvc.status()) {
                <span class="muted">{{ crateSvc.status() }}</span>
              }
            </div>
          </div>
        </div>
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
              @if (updater.rateLimitedMs() > 0) {
                <span>
                  · {{ throttledLabel() }} of that was spent waiting out tunebat rate limits.
                </span>
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
  readonly crateSvc = inject(CrateService);
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
    const crates = this.crateSvc.crates();
    const out: Row[] = [];
    for (const r of this.col.records()) {
      const tracks = r.tracks.filter(
        (t) => matchesTrack(t, f) && inAnyCrate(crates, f.crates, t)
      );
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

  toggle(facet: 'genres' | 'styles' | 'keys' | 'crates', value: string): void {
    this.fs.toggle(this.filters, facet, value);
  }

  // --- Crates -------------------------------------------------------------

  readonly showCrates = signal(false);
  readonly newCrateName = signal('');
  /** Track whose crate membership is being edited, positioned near the click. */
  readonly cratePicker = signal<{ x: number; y: number; track: Track } | null>(null);

  openCrates(): void {
    this.closePopover();
    this.showCrates.set(true);
  }

  closeCrates(): void {
    this.showCrates.set(false);
  }

  createCrate(): void {
    const name = this.newCrateName().trim();
    if (!name) return;
    this.crateSvc.create(name);
    this.newCrateName.set('');
  }

  /** Creates a crate from the picker and drops the current track straight in. */
  createCrateWith(t: Track): void {
    const name = this.newCrateName().trim();
    if (!name) return;
    const crate = this.crateSvc.create(name);
    this.crateSvc.add(crate.id, t);
    this.newCrateName.set('');
  }

  deleteCrate(id: string, name: string): void {
    if (!confirm(`Delete the crate "${name}"? The records themselves are not touched.`)) return;
    this.crateSvc.remove(id);
    // Drop it from the filter too, so the view doesn't silently show nothing.
    if (this.filters().crates.includes(id)) this.fs.toggle(this.filters, 'crates', id);
  }

  /**
   * Crates behave exactly like the genre/style facets: each chip is an
   * independent toggle, several can be on at once (a track shown if it is in
   * any of them), and turning them all off shows the whole collection again.
   */
  clearCrates(): void {
    this.fs.setCrates(this.filters, []);
  }

  openCratePicker(ev: MouseEvent, track: Track): void {
    ev.stopPropagation();
    const pos = this.clampToViewport(ev.clientX + 4, ev.clientY + 4, 300, 320);
    this.cratePicker.set({ x: pos.x, y: pos.y, track });
  }

  closeCratePicker(): void {
    this.cratePicker.set(null);
    this.newCrateName.set('');
  }

  /** Tooltip listing the crates a track is in. */
  crateTitle(t: Track): string {
    const names = this.crateSvc.cratesOf(t).map((c) => c.name);
    return names.length ? 'In crates: ' + names.join(', ') : 'Add to a crate';
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
    // ~500ms pacing plus a typical request, so about a second per track. The
    // real figure is whatever the live ETA settles on once tunebat's
    // throttling (if any) shows itself.
    const bestCase = Math.ceil(n / 60);
    const ok = confirm(
      `Re-check all ${n} tracks against tunebat?\n\n` +
        `This ignores the local cache and overwrites any key/BPM that comes ` +
        `back different.\n\n` +
        `Roughly ${bestCase} minute(s) if tunebat doesn't rate-limit. It will ` +
        `back off for up to a minute each time it does, so the run can take ` +
        `considerably longer — a live estimate is shown while it runs, and you ` +
        `can cancel at any point without losing corrections already made.`
    );
    if (ok) void this.updater.refetchAll();
  }

  /** "3m 20s" / "45s" for the remaining-time badge. */
  readonly etaLabel = computed(() => formatDuration(this.updater.etaMs() ?? 0));

  /** Time lost to 429 backoffs so far. */
  readonly throttledLabel = computed(() => formatDuration(this.updater.rateLimitedMs()));

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

  /** Pitch range is numeric; keep the last good value when the box is cleared. */
  setPitchRange(value: string): void {
    const n = parseFloat(value);
    this.config.update({ pitchRange: Number.isFinite(n) && n > 0 ? n : 8 });
  }
}

