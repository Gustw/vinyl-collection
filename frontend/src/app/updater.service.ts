import { Injectable, computed, inject, signal } from '@angular/core';
import { CollectionService } from './collection.service';
import { ConfigService } from './config.service';
import { Rec, Track, trackKey } from './models';
import { sameKeyName } from './camelot';
import {
  CollectionEntry,
  fetchCollection,
  fetchReleaseDetail,
  wasReleaseCached,
} from './discogs';
import { lookupKeyBeatport } from './beatport';
import { KeyInfo, lookupKeyData } from './keydata';
import { renderTracksTxt } from './tracks-format';
import { getTracksFile, githubConfigured, putTracksFile } from './github';
import { waitFor } from './timers';

/**
 * Which service a re-fetch pass asks.
 *
 * `auto` is the normal pipeline: Beatport, then tunebat for whatever Beatport
 * doesn't carry. `beatport` asks Beatport alone — the repair pass for a
 * collection whose values were filled in by tunebat's audio analysis, where
 * falling back would just re-confirm the very numbers being questioned.
 */
export type RefetchSource = 'auto' | 'beatport';

/** Where an unfinished re-fetch pass got to, kept across cancels and reloads. */
const REFETCH_PROGRESS_KEY = 'app.refetch.progress';

/** Each source keeps its own cursor, so the two passes don't overwrite each other. */
function progressKey(source: RefetchSource): string {
  return source === 'auto' ? REFETCH_PROGRESS_KEY : `${REFETCH_PROGRESS_KEY}.${source}`;
}

/** Human name of a source, for status lines and confirmations. */
function sourceLabel(source: RefetchSource): string {
  return source === 'beatport' ? 'Beatport' : 'Beatport/tunebat';
}

/**
 * Cap on the corrections carried between segments of one pass. A full re-check
 * of a large collection could in principle correct thousands of tracks, and the
 * report is a review aid rather than an audit log, so it is bounded.
 */
const MAX_REMEMBERED_CHANGES = 300;

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

/**
 * How far an interrupted re-fetch pass got, so the next run carries on instead
 * of re-checking thousands of tracks that were already done.
 *
 * The cursor is a *track key*, not a bare index: track ids are reassigned every
 * time tracks.txt is parsed, and positions shift whenever the collection grows,
 * so a stored number alone would silently skip or repeat work. The index is
 * kept only as a hint, to pick the right one when the same artist/title appears
 * more than once.
 */
export interface RefetchProgress {
  /** Key of the last track completed. */
  lastKey: string;
  /** Index it sat at when saved. */
  index: number;
  /** Length of the job list at the time, for the "N of M" display. */
  total: number;
  /** Corrections made across the whole pass so far, not just this segment. */
  corrected: number;
  /** Tracks whose existing value this pass could not confirm. */
  unconfirmed?: number;
  /** The corrections themselves, so the report covers the whole pass. */
  changes: TrackChange[];
  updatedAt: number;
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

/**
 * True when two key readings name the same key, however they spell it.
 *
 * Sources disagree about enharmonics: the collection holds "A# minor" where
 * Beatport says "Bb minor", and "C# major" against its "Db major". These are
 * the same key and the same wheel position, so rewriting one into the other is
 * pure churn — it would report hundreds of "corrections", rewrite tracks.txt on
 * every pass and bury the handful of real fixes in the report. The Camelot code
 * is the spelling-independent identity, so it decides whenever one can be had:
 * from the stored codes if both sides have them, else derived from the names.
 */
function sameKey(
  oldName: string,
  oldCamelot: string,
  newName: string,
  newCamelot: string
): boolean {
  if (oldCamelot && newCamelot) return oldCamelot === newCamelot;
  return sameKeyName(oldName, newName);
}

/**
 * True when two tempos are the same count read at different rates — 87 against
 * 175, say.
 *
 * Sources disagree about whether drum & bass is notated at its played tempo or
 * at half of it, and Beatport is not even consistent with itself: its
 * catalogue lists jungle at 83 and 91 next to other drum & bass at 155 and 170.
 * That disagreement says nothing about which of them has the right record, so
 * it must not be mistaken for a correction.
 */
function isTempoConventionClash(oldBpm: string, newBpm: string): boolean {
  const a = Number(oldBpm);
  const b = Number(newBpm);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  const ratio = a > b ? a / b : b / a;
  return Math.abs(ratio - 2) <= 0.06; // 2x within ~3%, covering rounding
}

function newTrack(title: string, artist: string): Track {
  return {
    id: 0,
    title,
    artist,
    position: '',
    duration: '',
    keyName: '',
    camelot: '',
    keyText: '',
    bpm: '',
    manualKey: false,
    manualBpm: false,
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
  /**
   * Tracks that already had a key/BPM but which this pass could not confirm —
   * no source offered anything convincingly the same recording (or none was
   * reachable). Their existing value is left alone, so it is worth surfacing:
   * those are the ones most likely to still be wrong, since the values in
   * tracks.txt predate match verification.
   */
  readonly unconfirmed = signal(0);
  /**
   * Tracks this pass deliberately skipped because their key and BPM were both
   * corrected by hand. Surfaced so a run that "corrected nothing" is not
   * mistaken for a run that failed.
   */
  readonly manuallyLocked = signal(0);
  /** What the re-fetch pass changed, for the summary shown when it finishes. */
  readonly changes = signal<TrackChange[]>([]);
  /** Set once a re-fetch pass has finished, so the UI can show its report. */
  readonly reportReady = signal(false);

  /** Total time this run has spent parked on tunebat 429 backoffs. */
  readonly rateLimitedMs = signal(0);
  /**
   * Estimated time left, in ms (null when not meaningful yet). Derived from
   * actual wall-clock progress, so rate-limit waits are already priced in:
   * if tunebat starts throttling, the estimate grows to match.
   */
  readonly etaMs = signal<number | null>(null);
  /** Wall-clock start of the current run, for the ETA. */
  private runStart = 0;
  /**
   * How many items were already done when this run started. A resumed run has
   * only been going for a few seconds, so the pace must be measured over the
   * items *it* has processed, not everything the pass has ever done.
   */
  private runOffset = 0;

  /** Recomputes the ETA from observed pace (including any 429 waits). */
  private updateEta(done: number, total: number): void {
    const doneThisRun = done - this.runOffset;
    if (doneThisRun <= 0 || done >= total) {
      this.etaMs.set(null);
      return;
    }
    const perItem = (Date.now() - this.runStart) / doneThisRun;
    this.etaMs.set(Math.round(perItem * (total - done)));
  }

  // --- Resumable re-fetch progress ---------------------------------------

  private loadProgress(source: RefetchSource): RefetchProgress | null {
    try {
      const raw = localStorage.getItem(progressKey(source));
      if (!raw) return null;
      const p = JSON.parse(raw) as RefetchProgress;
      return p && typeof p.lastKey === 'string' && typeof p.index === 'number' ? p : null;
    } catch {
      return null;
    }
  }

  private saveProgress(source: RefetchSource, p: RefetchProgress): void {
    try {
      localStorage.setItem(progressKey(source), JSON.stringify(p));
    } catch {
      /* ignore quota errors — losing the cursor only costs repeated work */
    }
    this.resumeSignal(source).set(p);
  }

  private clearProgress(source: RefetchSource): void {
    try {
      localStorage.removeItem(progressKey(source));
    } catch {
      /* ignore */
    }
    this.resumeSignal(source).set(null);
  }

  /**
   * Where an interrupted re-fetch will pick up, or null when the next run
   * starts from the top. Drives the button label and its confirmation.
   */
  readonly resumePoint = signal<RefetchProgress | null>(this.loadProgress('auto'));
  /** The same, for the Beatport-only repair pass. */
  readonly resumePointBeatport = signal<RefetchProgress | null>(this.loadProgress('beatport'));

  private resumeSignal(source: RefetchSource) {
    return source === 'beatport' ? this.resumePointBeatport : this.resumePoint;
  }

  /** Discards a saved position so the next pass starts from track 1. */
  forgetProgress(source: RefetchSource = 'auto'): void {
    this.clearProgress(source);
  }

  /**
   * First index to process, given a saved cursor. Falls back to the start when
   * the remembered track can no longer be found — the collection has changed
   * enough that a position from the old list means nothing.
   */
  private resumeIndex(jobs: Track[], progress: RefetchProgress | null): number {
    if (!progress) return 0;
    const hint = progress.index;
    if (hint >= 0 && hint < jobs.length && trackKey(jobs[hint]) === progress.lastKey) {
      return hint + 1;
    }
    const found = jobs.findIndex((t) => trackKey(t) === progress.lastKey);
    return found >= 0 ? found + 1 : 0;
  }

  /**
   * Re-points remembered corrections at the current track ids, which are
   * reassigned on every parse — without this the report's links would open
   * whatever track happens to hold that id now.
   */
  private rehydrateChanges(changes: TrackChange[], jobs: Track[]): TrackChange[] {
    const idByKey = new Map<string, number>();
    for (const t of jobs) idByKey.set(trackKey(t), t.id);
    return changes.map((c) => ({ ...c, trackId: idByKey.get(trackKey(c)) ?? c.trackId }));
  }

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
   * Pauses for `ms`, noticing a cancellation promptly.
   *
   * Deliberately deadline-driven (see ./timers): counting fixed slices would
   * multiply every pacing delay by the browser's background-tab throttling,
   * turning a half-second pause into minutes whenever the tab isn't in front.
   */
  private async wait(ms: number): Promise<void> {
    await waitFor(ms, () => this.cancelling());
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
    this.rateLimitedMs.set(0);
    this.etaMs.set(null);
    this.runStart = Date.now();
    this.runOffset = 0;
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
        this.updateEta(this.processed(), ordered.length);
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
      this.etaMs.set(null);
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
   * Re-asks a source for the key + BPM of *every* track, ignoring the cached
   * answers, and overwrites the ones that come back different. Use this to
   * repair values that were looked up wrong. A track is only changed when
   * something actually comes back, so an empty or unreachable answer never
   * wipes existing data.
   *
   * `source` picks who is asked: `auto` runs the normal Beatport-then-tunebat
   * chain, `beatport` asks Beatport alone. The Beatport-only pass exists
   * because falling back would defeat its purpose — it is there to replace
   * analysed numbers with the label's published ones, and a tunebat answer is
   * the very thing being questioned.
   *
   * A pass that is cancelled (or cut short by a closed tab) remembers where it
   * got to and the next run carries on from there. The position is only cleared
   * once the end of the list is reached, so the pass then starts over. Each
   * source has its own cursor.
   */
  async refetchAll(
    opts: { restart?: boolean; source?: RefetchSource } = {}
  ): Promise<void> {
    if (this.running()) return;
    const cfg = this.config.config();
    const source: RefetchSource = opts.source ?? 'auto';
    const who = sourceLabel(source);

    const records = this.col.records();
    const jobs = records.flatMap((r) => r.tracks);
    // Guard: with no collection loaded every cursor would look "past the end"
    // and a saved position would be thrown away for nothing.
    if (!jobs.length) {
      this.message.set('Nothing to re-fetch — the collection is still loading.');
      return;
    }

    // Work out where to begin before touching any of the progress signals.
    if (opts.restart) this.clearProgress(source);
    const saved = opts.restart ? null : this.loadProgress(source);
    let startAt = this.resumeIndex(jobs, saved);
    if (startAt >= jobs.length) {
      // The saved cursor sat on the last track: the pass is finished, so this
      // run is a fresh one.
      startAt = 0;
      this.clearProgress(source);
    }
    const resuming = startAt > 0 && !!saved;

    this.running.set(true);
    this.cancelling.set(false);
    this.error.set(null);
    this.total.set(jobs.length);
    this.processed.set(startAt);
    this.corrected.set(resuming ? saved!.corrected : 0);
    this.unconfirmed.set(resuming ? saved!.unconfirmed ?? 0 : 0);
    this.manuallyLocked.set(0);
    this.changes.set(resuming ? this.rehydrateChanges(saved!.changes ?? [], jobs) : []);
    this.reportReady.set(false);
    this.rateLimitedMs.set(0);
    this.etaMs.set(null);
    this.runStart = Date.now();
    this.runOffset = startAt;
    this.canCommit = githubConfigured(cfg) && !!cfg.githubToken;

    try {
      this.total.set(jobs.length);
      if (resuming) {
        this.message.set(
          `Resuming ${who} re-fetch at track ${startAt + 1} of ${jobs.length}…`
        );
      }

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
      let finished = true;
      for (let i = startAt; i < jobs.length; i++) {
        const t = jobs[i];
        if (this.cancelling()) {
          finished = false;
          break; // stop cleanly, then save below
        }

        // A track whose key *and* BPM were both set by hand has nothing this
        // pass may change, so don't spend a request (or a rate-limit slot) on
        // asking a question whose answer must be discarded.
        const lock = this.col.manualLock(t);
        if (lock.key && lock.bpm) {
          this.manuallyLocked.update((n) => n + 1);
          this.processed.update((n) => n + 1);
          this.updateEta(this.processed(), jobs.length);
          this.saveProgress(source, {
            lastKey: trackKey(t),
            index: i,
            total: jobs.length,
            corrected: this.corrected(),
            unconfirmed: this.unconfirmed(),
            changes: this.changes().slice(-MAX_REMEMBERED_CHANGES),
            updatedAt: Date.now(),
          });
          continue;
        }

        this.message.set(
          `Re-checking ${t.artist} - ${t.title} on ${who}… ` +
            `(${i + 1}/${jobs.length}, ${this.corrected()} corrected)`
        );
        try {
          const lookupOpts = {
            onStatus: (s: string) => this.message.set(s),
            force: true,
            isCancelled: () => this.cancelling(),
            onRateLimitWait: (ms: number) => this.rateLimitedMs.update((n) => n + ms),
          };
          const info =
            source === 'beatport'
              ? await lookupKeyBeatport(cfg, t.artist, t.title, lookupOpts)
              : await lookupKeyData(cfg, t.artist, t.title, lookupOpts);
          const change = this.applyFresh(t, info);
          if (change) {
            this.changes.update((list) => [...list, change]);
            this.corrected.update((n) => n + 1);
            sinceCommit++;
          } else if (!info.keyName && !info.bpm && (t.keyName || t.bpm)) {
            // Nothing came back that was convincingly this recording, so the
            // existing value stands — unverified rather than confirmed.
            this.unconfirmed.update((n) => n + 1);
          }
        } catch (e) {
          console.warn('re-fetch failed for', t.artist, t.title, e);
        }
        this.processed.update((n) => n + 1);
        this.updateEta(this.processed(), jobs.length);
        this.push(records);
        // Recorded after the track is done, so the cursor always points at
        // completed work and resuming never skips a track.
        this.saveProgress(source, {
          lastKey: trackKey(t),
          index: i,
          total: jobs.length,
          corrected: this.corrected(),
          unconfirmed: this.unconfirmed(),
          changes: this.changes().slice(-MAX_REMEMBERED_CHANGES),
          updatedAt: Date.now(),
        });
        await this.wait(500); // be polite to the API (reduces 429s)
        if (sinceCommit >= 10) {
          sinceCommit = 0;
          await this.commit(records, cfg);
        }
      }

      // Reaching the end retires the cursor, so the next run starts over.
      if (finished) this.clearProgress(source);

      // Always commit: this is also the save-on-cancel path.
      await this.commit(records, cfg);
      const n = this.corrected();
      const fixed = n === 0 ? 'nothing needed correcting' : `${n} track(s) corrected`;
      const locked = this.manuallyLocked()
        ? `; ${this.manuallyLocked()} left alone (corrected by hand)`
        : '';
      const note = finished
        ? `${who}: ${fixed}${locked}`
        : `${who}: ${fixed}${locked}; will resume at track ${this.processed() + 1} of ${jobs.length}`;
      this.message.set(this.finishMessage('Re-fetch', !finished, note));
    } catch (e) {
      this.error.set(String(e));
      this.message.set('Re-fetch failed: ' + e);
      await this.commit(records, cfg); // don't lose corrections already made
    } finally {
      this.running.set(false);
      this.cancelling.set(false);
      this.etaMs.set(null);
      this.reportReady.set(true); // show the summary, even for a partial run
    }
  }

  /**
   * Overwrites a track's key/BPM with a freshly fetched answer when it differs.
   * Returns a change record when something actually changed, else null. Empty
   * fields in `info` are ignored so a failed/blocked lookup can never erase
   * good data.
   *
   * A tempo that is exactly half or double what is already recorded is *not*
   * treated as a correction: it is the two sources counting the same record
   * differently. Overwriting on that basis would quietly halve the BPM of a
   * jungle collection, and every mixable pair and bridge computed from it.
   * A key that is merely spelled differently (A# minor vs Bb minor) is left
   * alone for the same reason.
   *
   * Fields the user has corrected by hand are never touched at all: a manual
   * edit outranks any catalogue, and silently reverting one — then committing
   * the reversion — is the worst thing this pass could do.
   */
  private applyFresh(t: Track, info: KeyInfo): TrackChange | null {
    const lock = this.col.manualLock(t);
    const keyChanged =
      !lock.key && !!info.keyName && !sameKey(t.keyName, t.camelot, info.keyName, info.camelot);
    const tempoClash = isTempoConventionClash(t.bpm, info.bpm);
    const bpmChanged = !lock.bpm && !!info.bpm && info.bpm !== t.bpm && !tempoClash;
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
    //
    // Positions are part of that test: without it, a collection whose keys and
    // BPMs were all filled in before positions existed would be "complete"
    // forever and would never pick them up. Records Discogs has no positions
    // for do get re-examined each run, but the release JSON is cached in
    // localStorage so that costs a local read rather than an API call.
    const complete =
      rec.tracks.length > 0 &&
      rec.tracks.every((t) => t.keyName && t.bpm) &&
      rec.tracks.some((t) => t.position);
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
      // Discogs is authoritative for the pressing's own facts.
      if (dt.position) t.position = dt.position;
      if (dt.duration) t.duration = dt.duration;
      return t;
    });
    rec.tracks = merged;
    onProgress();

    // Fill gaps from Beatport (falling back to tunebat). Only blanks are
    // filled, so a value that is already there is never replaced — which also
    // means a manual correction is safe here. The lock is still consulted for
    // the case of a hand-cleared field: someone who deleted a bogus BPM meant
    // it to stay empty, not to be refilled on the next pass.
    for (const t of rec.tracks) {
      if (t.keyName && t.bpm) continue;
      const lock = this.col.manualLock(t);
      if ((t.keyName || lock.key) && (t.bpm || lock.bpm)) continue;
      this.throwIfCancelled(); // the record keeps whatever we filled so far
      const info = await lookupKeyData(cfg, t.artist, t.title, {
        onStatus: (s) => this.message.set(s),
        isCancelled: () => this.cancelling(),
        onRateLimitWait: (ms) => this.rateLimitedMs.update((n) => n + ms),
      });
      if (info.keyName && !t.keyName && !lock.key) {
        t.keyName = info.keyName;
        t.camelot = info.camelot;
        t.keyText = info.keyText;
      }
      if (info.bpm && !t.bpm && !lock.bpm) t.bpm = info.bpm;
      onProgress();
      await this.wait(500); // be polite to the APIs (reduces 429s)
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
      this.col.markSynced();
    } catch (e) {
      this.canCommit = false; // stop trying after a failure (e.g. sha conflict)
      // Record it durably so the run's results are retried later rather than
      // living only in this browser's caches. The retry re-reads the sha, so
      // the conflict that stopped this run doesn't stop that one.
      this.col.markPending(
        `Update collection (${this.processed()}/${this.total()})`,
        String(e)
      );
      this.message.set('Saved partially; GitHub commit failed: ' + e);
    }
  }
}

