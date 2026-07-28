import { Injectable, computed, inject, signal } from '@angular/core';
import { CollectionService } from './collection.service';
import { ConfigService } from './config.service';
import { Rec, Track } from './models';
import {
  CollectionEntry,
  fetchCollection,
  fetchReleaseDetail,
  wasReleaseCached,
} from './discogs';
import { lookupKey, KeyInfo } from './tunebat';
import { renderTracksTxt } from './tracks-format';
import { getTracksFile, githubConfigured, putTracksFile } from './github';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thrown internally to unwind a pipeline when the user cancels it. */
class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/** One track corrected by a re-fetch pass, with its before/after values. */
export interface TrackChange {
  trackId: number;
  title: string;
  artist: string;
  recordTitle: string;
  oldKeyText: string;
  newKeyText: string;
  oldBpm: string;
  newBpm: string;
  /** Which fields actually differ (drives the highlighting in the report). */
  keyChanged: boolean;
  bpmChanged: boolean;
}

function entryToRec(e: CollectionEntry): Rec {
  return {
    releaseId: e.releaseId,
    title: e.title,
    artist: e.artist,
    genres: e.genres,
    styles: e.styles,
    year: e.year,
    labels: e.labels,
    artwork: e.artwork,
    tracks: [],
  };
}

/** Case-insensitive title\u0000artist key for matching records without an id. */
function nameKey(title: string, artist: string): string {
  return `${(title || '').trim()}\u0000${(artist || '').trim()}`.toLowerCase();
}

function newTrack(title: string, artist: string): Track {
  return {
    id: 0,
    title,
    artist,
    keyName: '',
    camelot: '',
    keyText: '',
    bpm: '',
    recordTitle: '',
    recordArtist: '',
    genres: [],
    styles: [],
    year: 0,
    labels: [],
    artwork: '',
    releaseId: '',
  };
}

/**
 * Runs the whole Discogs -> tunebat -> tracks.txt pipeline entirely in the
 * browser (the port of the Java tool), updating the UI live and committing the
 * merged tracks.txt back to GitHub. tracks.txt is merged (never wiped): existing
 * records keep their keys/BPM and only new records/corrections are applied.
 */
@Injectable({ providedIn: 'root' })
export class UpdaterService {
  private readonly col = inject(CollectionService);
  private readonly config = inject(ConfigService);

  readonly running = signal(false);
  readonly processed = signal(0);
  readonly total = signal(0);
  readonly message = signal('');
  readonly error = signal<string | null>(null);

  readonly missingKeys = computed(() => this.col.tracks().filter((t) => !t.keyName).length);
  readonly missingBpm = computed(() => this.col.tracks().filter((t) => !t.bpm).length);
  readonly totalTracks = computed(() => this.col.tracks().length);

  /** How many tracks the current re-fetch pass actually corrected. */
  readonly corrected = signal(0);
  /** What the re-fetch pass changed, for the summary shown when it finishes. */
  readonly changes = signal<TrackChange[]>([]);
  /** Set once a re-fetch pass has finished, so the UI can show its report. */
  readonly reportReady = signal(false);

  /**
   * Set while a cancellation is being honoured. The running job stops at its
   * next checkpoint and still commits whatever it has already changed, so no
   * work is thrown away.
   */
  readonly cancelling = signal(false);

  /** Asks the running job to stop as soon as it can, saving its progress. */
  cancel(): void {
    if (!this.running() || this.cancelling()) return;
    this.cancelling.set(true);
    this.message.set('Cancelling — saving what has been done so far…');
  }

  dismissReport(): void {
    this.reportReady.set(false);
  }

  /**
   * Sleeps in small slices so a cancellation is noticed quickly instead of
   * after a full pacing delay.
   */
  private async wait(ms: number): Promise<void> {
    const step = 100;
    let left = ms;
    while (left > 0 && !this.cancelling()) {
      const slice = Math.min(step, left);
      await sleep(slice);
      left -= slice;
    }
  }

  /** Throws to unwind the pipeline when the user asked to stop. */
  private throwIfCancelled(): void {
    if (this.cancelling()) throw new CancelledError();
  }

  private sha: string | undefined;
  private canCommit = true;

  async start(): Promise<void> {
    if (this.running()) return;
    const cfg = this.config.config();
    this.running.set(true);
    this.cancelling.set(false);
    this.error.set(null);
    this.processed.set(0);
    this.total.set(0);
    this.canCommit = githubConfigured(cfg) && !!cfg.githubToken;

    const paceMs = cfg.discogsToken.trim() ? 1100 : 2500;

    // Kept outside the try so the cancel path can still commit what we have.
    let ordered: Rec[] | null = null;

    try {
      // Seed lookups from what's already on screen so existing records keep
      // their tracks/keys/BPM. Match by releaseId AND by title\u0000artist so
      // records exported before ID lines existed still merge (never wiped).
      const existingRecs = this.col.records();
      const byId = new Map<string, Rec>();
      const byName = new Map<string, Rec>();
      for (const r of existingRecs) {
        if (r.releaseId) byId.set(r.releaseId, r);
        byName.set(nameKey(r.title, r.artist), r);
      }

      // 1) Enumerate the user's full Discogs collection.
      this.message.set('Fetching collection…');
      const entries = await fetchCollection(
        cfg,
        (p, tp) => this.message.set(`Fetching collection… page ${p}/${tp}`),
        // Pacing doubles as the cancellation checkpoint for the paging loop.
        async () => {
          await this.wait(paceMs);
          this.throwIfCancelled();
        }
      );

      // 2) Merge into an ordered list; the collection defines the visible order.
      //    Existing records are updated in place (tracks/keys/BPM preserved);
      //    only genuinely new releases are appended.
      const merged: Rec[] = [];
      const seen = new Set<Rec>();
      for (const e of entries) {
        let rec: Rec | undefined =
          (e.releaseId ? byId.get(e.releaseId) : undefined) ??
          byName.get(nameKey(e.title, e.artist));
        if (rec) {
          // Adopt the id (older exports lack it) and only fill blank facets.
          if (!rec.releaseId && e.releaseId) {
            rec.releaseId = e.releaseId;
            byId.set(e.releaseId, rec);
          }
          rec.title ||= e.title;
          rec.artist ||= e.artist;
          if (!rec.genres.length) rec.genres = e.genres;
          if (!rec.styles.length) rec.styles = e.styles;
          if (!rec.year) rec.year = e.year;
          if (!rec.labels.length) rec.labels = e.labels;
          if (!rec.artwork) rec.artwork = e.artwork;
        } else {
          rec = entryToRec(e);
        }
        if (!seen.has(rec)) {
          seen.add(rec);
          merged.push(rec);
        }
      }
      // Safety net: keep any existing record that didn't match a collection
      // entry (e.g. name drift) so its tracks are never dropped from the view.
      for (const r of existingRecs) {
        if (!seen.has(r)) {
          seen.add(r);
          merged.push(r);
        }
      }
      ordered = merged;
      this.total.set(ordered.length);
      this.push(ordered);

      // Read the current file sha once so commits update (not clobber) it.
      if (this.canCommit) {
        try {
          const file = await getTracksFile(cfg);
          this.sha = file?.sha;
        } catch (e) {
          this.canCommit = false;
          this.message.set('Could not read tracks.txt from GitHub: ' + e);
        }
      }

      // 3) Enrich each record with its tracklist + keys/BPM.
      let sinceCommit = 0;
      for (const rec of ordered) {
        if (this.cancelling()) break; // stop cleanly, then save below
        this.message.set(`Updating ${rec.title || rec.releaseId}…`);
        try {
          await this.enrich(rec, cfg, paceMs, () => this.push(ordered!));
        } catch (e) {
          if (e instanceof CancelledError) break;
          // Keep going; a failed record just stays as-is and is retried next run.
          console.warn('enrich failed for', rec.releaseId, e);
        }
        this.processed.update((n) => n + 1);
        this.push(ordered);
        if (++sinceCommit >= 10) {
          sinceCommit = 0;
          await this.commit(ordered, cfg);
        }
      }

      // Always commit: this is also the save-on-cancel path.
      await this.commit(ordered, cfg);
      this.message.set(this.finishMessage('Update', this.cancelling()));
    } catch (e) {
      if (e instanceof CancelledError) {
        // Cancelled mid-collection-fetch: still persist anything already merged.
        if (ordered) await this.commit(ordered, cfg);
        this.message.set(this.finishMessage('Update', true));
      } else {
        this.error.set(String(e));
        this.message.set('Update failed: ' + e);
      }
    } finally {
      this.running.set(false);
      this.cancelling.set(false);
    }
  }

  /** Closing status line for a finished / cancelled pipeline. */
  private finishMessage(kind: 'Update' | 'Re-fetch', cancelled: boolean, extra = ''): string {
    const what = cancelled ? `${kind} cancelled` : `${kind} complete`;
    const detail = extra ? ` — ${extra}` : '';
    const saved = this.canCommit
      ? cancelled
        ? ', progress so far saved to GitHub.'
        : ', saved to GitHub.'
      : ' (not saved: configure a GitHub token to persist).';
    return what + detail + saved;
  }

  /**
   * Re-asks tunebat for the key + BPM of *every* track, ignoring the cached
   * answers, and overwrites the ones that come back different. Use this to
   * repair values that were looked up wrong. A track is only changed when
   * tunebat actually returns something, so an empty or unreachable answer
   * never wipes existing data.
   */
  async refetchAll(): Promise<void> {
    if (this.running()) return;
    const cfg = this.config.config();
    this.running.set(true);
    this.cancelling.set(false);
    this.error.set(null);
    this.processed.set(0);
    this.corrected.set(0);
    this.changes.set([]);
    this.reportReady.set(false);
    this.canCommit = githubConfigured(cfg) && !!cfg.githubToken;

    const records = this.col.records();

    try {
      const jobs = records.flatMap((r) => r.tracks);
      this.total.set(jobs.length);

      if (this.canCommit) {
        try {
          const file = await getTracksFile(cfg);
          this.sha = file?.sha;
        } catch (e) {
          this.canCommit = false;
          this.message.set('Could not read tracks.txt from GitHub: ' + e);
        }
      }

      let sinceCommit = 0;
      for (const t of jobs) {
        if (this.cancelling()) break; // stop cleanly, then save below
        this.message.set(
          `Re-checking ${t.artist} - ${t.title}… ` +
            `(${this.processed() + 1}/${jobs.length}, ${this.corrected()} corrected)`
        );
        try {
          const info = await lookupKey(
            cfg,
            t.artist,
            t.title,
            (s) => this.message.set(s),
            true,
            () => this.cancelling()
          );
          const change = this.applyFresh(t, info);
          if (change) {
            this.changes.update((list) => [...list, change]);
            this.corrected.update((n) => n + 1);
            sinceCommit++;
          }
        } catch (e) {
          console.warn('re-fetch failed for', t.artist, t.title, e);
        }
        this.processed.update((n) => n + 1);
        this.push(records);
        await this.wait(500); // be polite to tunebat (reduces 429s)
        if (sinceCommit >= 10) {
          sinceCommit = 0;
          await this.commit(records, cfg);
        }
      }

      // Always commit: this is also the save-on-cancel path.
      await this.commit(records, cfg);
      const n = this.corrected();
      const fixed = n === 0 ? 'nothing needed correcting' : `${n} track(s) corrected`;
      this.message.set(this.finishMessage('Re-fetch', this.cancelling(), fixed));
    } catch (e) {
      this.error.set(String(e));
      this.message.set('Re-fetch failed: ' + e);
      await this.commit(records, cfg); // don't lose corrections already made
    } finally {
      this.running.set(false);
      this.cancelling.set(false);
      this.reportReady.set(true); // show the summary, even for a partial run
    }
  }

  /**
   * Overwrites a track's key/BPM with a freshly fetched answer when it differs.
   * Returns a change record when something actually changed, else null. Empty
   * fields in `info` are ignored so a failed/blocked lookup can never erase
   * good data.
   */
  private applyFresh(t: Track, info: KeyInfo): TrackChange | null {
    const keyChanged =
      !!info.keyName && (info.keyName !== t.keyName || info.camelot !== t.camelot);
    const bpmChanged = !!info.bpm && info.bpm !== t.bpm;
    if (!keyChanged && !bpmChanged) return null;

    const change: TrackChange = {
      trackId: t.id,
      title: t.title,
      artist: t.artist,
      recordTitle: t.recordTitle,
      oldKeyText: t.keyText,
      newKeyText: keyChanged ? info.keyText : t.keyText,
      oldBpm: t.bpm,
      newBpm: bpmChanged ? info.bpm : t.bpm,
      keyChanged,
      bpmChanged,
    };

    if (keyChanged) {
      t.keyName = info.keyName;
      t.camelot = info.camelot;
      t.keyText = info.keyText;
    }
    if (bpmChanged) t.bpm = info.bpm;
    return change;
  }

  /** Fetches a release's tracklist and fills missing keys/BPM, updating live. */
  private async enrich(
    rec: Rec,
    cfg: ReturnType<ConfigService['config']>,
    paceMs: number,
    onProgress: () => void
  ): Promise<void> {
    if (!rec.releaseId) return;

    // Fast path: nothing to do. If we already have tracks and every one has a
    // key + BPM, skip the release fetch and tunebat lookups entirely (caching).
    const complete =
      rec.tracks.length > 0 && rec.tracks.every((t) => t.keyName && t.bpm);
    if (complete) return;

    const cachedBefore = wasReleaseCached(rec.releaseId);
    const detail = await fetchReleaseDetail(cfg, rec.releaseId);
    if (!cachedBefore) await this.wait(paceMs);
    this.throwIfCancelled();

    // Record-level corrections/additions.
    if (detail.genres.length) rec.genres = detail.genres;
    if (detail.styles.length) rec.styles = detail.styles;
    if (detail.year) rec.year = detail.year;
    if (detail.labels.length) rec.labels = detail.labels;
    if (detail.artwork) rec.artwork = detail.artwork;

    // Merge tracklist, preserving any key/BPM we already had (matched by title).
    const prevByTitle = new Map<string, Track>();
    for (const t of rec.tracks) prevByTitle.set(t.title.toLowerCase(), t);
    const merged: Track[] = detail.tracks.map((dt) => {
      const prev = prevByTitle.get(dt.title.toLowerCase());
      const t = prev ?? newTrack(dt.title, dt.artist);
      t.title = dt.title;
      t.artist = dt.artist || t.artist;
      return t;
    });
    rec.tracks = merged;
    onProgress();

    // Fill gaps from tunebat. Only blanks are filled, so a value that is
    // already there is never replaced.
    for (const t of rec.tracks) {
      if (t.keyName && t.bpm) continue;
      this.throwIfCancelled(); // the record keeps whatever we filled so far
      const info = await lookupKey(
        cfg,
        t.artist,
        t.title,
        (s) => this.message.set(s),
        false,
        () => this.cancelling()
      );
      if (info.keyName && !t.keyName) {
        t.keyName = info.keyName;
        t.camelot = info.camelot;
        t.keyText = info.keyText;
      }
      if (info.bpm && !t.bpm) t.bpm = info.bpm;
      onProgress();
      await this.wait(500); // be polite to tunebat (reduces 429s)
    }
  }

  private push(records: Rec[]): void {
    this.col.setRecords(records);
  }

  private async commit(
    records: Rec[],
    cfg: ReturnType<ConfigService['config']>
  ): Promise<void> {
    if (!this.canCommit) return;
    // Safety net: never overwrite tracks.txt with an empty file (e.g. cancelled
    // before the collection finished loading).
    if (!records.length) return;
    try {
      const text = renderTracksTxt(records);
      const suffix = this.cancelling() ? ', cancelled' : '';
      this.sha = await putTracksFile(
        cfg,
        text,
        this.sha,
        `Update collection (${this.processed()}/${this.total()}${suffix})`
      );
    } catch (e) {
      this.canCommit = false; // stop trying after a failure (e.g. sha conflict)
      this.message.set('Saved partially; GitHub commit failed: ' + e);
    }
  }
}

