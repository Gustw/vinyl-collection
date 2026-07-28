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
import { lookupKey } from './tunebat';
import { renderTracksTxt } from './tracks-format';
import { getTracksFile, githubConfigured, putTracksFile } from './github';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  private sha: string | undefined;
  private canCommit = true;

  async start(): Promise<void> {
    if (this.running()) return;
    const cfg = this.config.config();
    this.running.set(true);
    this.error.set(null);
    this.processed.set(0);
    this.total.set(0);
    this.canCommit = githubConfigured(cfg) && !!cfg.githubToken;

    const paceMs = cfg.discogsToken.trim() ? 1100 : 2500;

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
        () => sleep(paceMs)
      );

      // 2) Merge into an ordered list; the collection defines the visible order.
      //    Existing records are updated in place (tracks/keys/BPM preserved);
      //    only genuinely new releases are appended.
      const ordered: Rec[] = [];
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
          ordered.push(rec);
        }
      }
      // Safety net: keep any existing record that didn't match a collection
      // entry (e.g. name drift) so its tracks are never dropped from the view.
      for (const r of existingRecs) {
        if (!seen.has(r)) {
          seen.add(r);
          ordered.push(r);
        }
      }
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
        this.message.set(`Updating ${rec.title || rec.releaseId}…`);
        try {
          await this.enrich(rec, cfg, paceMs, () => this.push(ordered));
        } catch (e) {
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

      await this.commit(ordered, cfg);
      this.message.set(
        this.canCommit ? 'Update complete and saved to GitHub.' : 'Update complete (not saved: configure a GitHub token to persist).'
      );
    } catch (e) {
      this.error.set(String(e));
      this.message.set('Update failed: ' + e);
    } finally {
      this.running.set(false);
    }
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
    if (!cachedBefore) await sleep(paceMs);

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

    // Fill gaps from tunebat.
    for (const t of rec.tracks) {
      if (t.keyName && t.bpm) continue;
      const info = await lookupKey(cfg, t.artist, t.title, (s) => this.message.set(s));
      if (info.keyName) {
        t.keyName = info.keyName;
        t.camelot = info.camelot;
        t.keyText = info.keyText;
      }
      if (info.bpm) t.bpm = info.bpm;
      onProgress();
      await sleep(500); // be polite to tunebat (reduces 429s)
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
    try {
      const text = renderTracksTxt(records);
      this.sha = await putTracksFile(
        cfg,
        text,
        this.sha,
        `Update collection (${this.processed()}/${this.total()} records)`
      );
    } catch (e) {
      this.canCommit = false; // stop trying after a failure (e.g. sha conflict)
      this.message.set('Saved partially; GitHub commit failed: ' + e);
    }
  }
}

