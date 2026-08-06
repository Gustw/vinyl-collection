import { Injectable, computed, inject, signal } from '@angular/core';
import { Rec, Track } from './models';
import { ConfigService } from './config.service';
import { keyNameToCamelot } from './camelot';
import { githubConfigured, getTracksFile, putTracksFile, rawUrl } from './github';
import { renderTracksTxt } from './tracks-format';
import { cachedKeyInfoAny } from './keydata';

const HEADER_RE = /^===\s(.*)\s===$/;
const TRACK_RE = /^\s*\d+\.\s+(.*)$/;
/**
 * The trailing metadata block:
 * `[Pos: A1 | Time: 6:32 | Key: A minor (8A) | BPM: 175 | Manual: key,bpm]`.
 * Every field is optional and older files carry only Key/BPM.
 */
const META_RE = /\s*\[([^\]]+)]\s*$/;
/** Any `Name: value` pair inside the block, known to this version or not. */
const META_PAIR_RE = /^([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/;
/** The fields this version understands. Others are read past, not choked on. */
const KNOWN_META = new Set(['pos', 'time', 'key', 'bpm', 'manual']);
const CAMELOT_RE = /\((\d{1,2}[AB])\)/;

/** Per-track fields parsed out of the trailing bracket block. */
interface TrackMeta {
  position: string;
  duration: string;
  keyText: string;
  bpm: string;
  manualKey: boolean;
  manualBpm: boolean;
}

/**
 * Splits a track line into its title/artist body and its metadata block.
 *
 * A block is only recognised when *every* `|` segment is a `Name: value` pair
 * and at least one of those names is a field we know. That pair of tests is
 * what keeps a title which merely ends in brackets — "Bad Boys [VIP]", or even
 * "Remix: Foo" — from being eaten as metadata, while still letting a file
 * written by a newer version (with fields this one has never heard of) be read
 * rather than silently losing its key and BPM.
 */
function splitTrackMeta(body: string): { body: string; meta: TrackMeta } {
  const meta: TrackMeta = {
    position: '',
    duration: '',
    keyText: '',
    bpm: '',
    manualKey: false,
    manualBpm: false,
  };
  const m = META_RE.exec(body);
  if (!m) return { body, meta };

  const segments = m[1].split('|').map((s) => s.trim());
  const fields = segments.map((s) => META_PAIR_RE.exec(s));
  if (fields.some((f) => !f)) return { body, meta }; // not a metadata block
  const names = fields.map((f) => f![1].trim().toLowerCase());
  if (!names.some((n) => KNOWN_META.has(n))) return { body, meta };

  for (let i = 0; i < fields.length; i++) {
    const name = names[i];
    const value = fields[i]![2].trim();
    // Positions are folded up on the way in as well as on the way out of
    // Discogs, so a file written before that was done still displays evenly.
    if (name === 'pos') meta.position = value.toUpperCase();
    else if (name === 'time') meta.duration = value;
    else if (name === 'key') meta.keyText = value;
    else if (name === 'bpm') meta.bpm = value;
    else if (name === 'manual') {
      // "key", "bpm", or both in either order and any of the obvious spellings.
      const parts = value.toLowerCase().split(/[,+;\s]+/).filter(Boolean);
      meta.manualKey = parts.includes('key');
      meta.manualBpm = parts.includes('bpm');
    }
  }
  return { body: body.replace(META_RE, '').trim(), meta };
}

/** Parses the plain-text export produced by the Java tool into records/tracks. */
export function parseTracksTxt(text: string): Rec[] {
  const records: Rec[] = [];
  let current: Rec | null = null;
  let id = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\uFEFF/g, '');
    const trimmed = line.trim();
    if (!trimmed) continue;

    const header = HEADER_RE.exec(trimmed);
    if (header) {
      const inner = header[1];
      const sep = inner.indexOf(' -- ');
      const title = sep >= 0 ? inner.slice(0, sep).trim() : inner.trim();
      const artist = sep >= 0 ? inner.slice(sep + 4).trim() : '';
      current = { releaseId: '', title, artist, genres: [], styles: [], year: 0, labels: [], artwork: '', tracks: [] };
      records.push(current);
      continue;
    }

    if (!current) continue;

    if (trimmed.toLowerCase().startsWith('id:')) {
      current.releaseId = trimmed.slice(trimmed.indexOf(':') + 1).trim();
      continue;
    }
    if (trimmed.toLowerCase().startsWith('genre:')) {
      current.genres = splitList(trimmed.slice(trimmed.indexOf(':') + 1));
      continue;
    }
    if (trimmed.toLowerCase().startsWith('style:')) {
      current.styles = splitList(trimmed.slice(trimmed.indexOf(':') + 1));
      continue;
    }
    if (trimmed.toLowerCase().startsWith('year:')) {
      const y = parseInt(trimmed.slice(trimmed.indexOf(':') + 1).trim(), 10);
      current.year = Number.isNaN(y) ? 0 : y;
      continue;
    }
    if (trimmed.toLowerCase().startsWith('label:')) {
      current.labels = splitList(trimmed.slice(trimmed.indexOf(':') + 1));
      continue;
    }
    if (trimmed.toLowerCase().startsWith('art:')) {
      current.artwork = trimmed.slice(trimmed.indexOf(':') + 1).trim();
      continue;
    }

    const tr = TRACK_RE.exec(line);
    if (tr) {
      const split = splitTrackMeta(tr[1].trim());
      const body = split.body;
      const keyText = split.meta.keyText;
      const bpm = split.meta.bpm;
      const cm = keyText ? CAMELOT_RE.exec(keyText) : null;
      const keyName = keyText ? keyText.replace(/\s*\([^)]*\)\s*$/, '').trim() : '';
      // Older files (and hand-edits) can carry a key name with no wheel
      // position. Deriving it keeps the track in the key filters and the
      // mixable lists instead of silently dropping out of both.
      const camelot = cm ? cm[1] : keyNameToCamelot(keyName);

      // Split "Title - Artist" on the LAST " - " (artists rarely contain it).
      const idx = body.lastIndexOf(' - ');
      const title = idx >= 0 ? body.slice(0, idx).trim() : body.trim();
      const artist = idx >= 0 ? body.slice(idx + 3).trim() : current.artist;

      current.tracks.push({
        id: id++,
        title,
        artist,
        position: split.meta.position,
        duration: split.meta.duration,
        keyName,
        camelot,
        keyText,
        bpm,
        // A lock is only meaningful over a value that is actually there: a
        // "Manual: bpm" left behind on a track whose BPM was later cleared
        // would otherwise freeze the field as permanently empty.
        manualKey: split.meta.manualKey && !!keyText,
        manualBpm: split.meta.manualBpm && !!bpm,
        recordTitle: current.title,
        recordArtist: current.artist,
        genres: current.genres,
        styles: current.styles,
        year: current.year,
        labels: current.labels,
        artwork: current.artwork,
        releaseId: current.releaseId,
      });
    }
  }

  // genres/styles/artwork may be parsed after the header; re-link references so
  // every track sees the final values for its record.
  for (const r of records) {
    for (const t of r.tracks) {
      t.genres = r.genres;
      t.styles = r.styles;
      t.year = r.year;
      t.labels = r.labels;
      t.artwork = r.artwork;
      t.releaseId = r.releaseId;
    }
  }

  return dedupeRecords(records);
}

/**
 * The export can contain the same record more than once (e.g. if two tool runs
 * wrote to tracks.txt concurrently). Collapse duplicates so every record shows
 * only once, keeping the most complete copy (most tracks, then most keys).
 */
function dedupeRecords(records: Rec[]): Rec[] {
  const byKey = new Map<string, Rec>();
  const order: string[] = [];

  const score = (r: Rec) => [
    r.tracks.length,
    r.tracks.filter((t) => !!t.keyName).length,
  ];

  for (const r of records) {
    const key = (r.releaseId ? `id:${r.releaseId}` : `${r.title}\u0000${r.artist}`).toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
      order.push(key);
      continue;
    }
    const [ec, ek] = score(existing);
    const [nc, nk] = score(r);
    if (nc > ec || (nc === ec && nk > ek)) {
      byKey.set(key, r); // replace with the more complete copy, keep position
    }
  }

  return order.map((k) => byKey.get(k)!);
}

function splitList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * Fills in any missing key/BPM on parsed records from the Beatport/tunebat
 * localStorage caches. This restores update progress after a page reload even
 * when it hasn't been committed to GitHub yet (e.g. no token configured, or a
 * refresh between commit checkpoints). Existing values are never overwritten.
 *
 * Hand-set fields are skipped outright. A field can be blank *because someone
 * deliberately emptied it* — a bogus BPM deleted on purpose — and refilling it
 * from a cache would undo that just as surely as overwriting a value would.
 */
export function hydrateFromKeyCache(records: Rec[]): void {
  for (const r of records) {
    for (const t of r.tracks) {
      if (t.keyName && t.bpm) continue;
      const cached = cachedKeyInfoAny(t.artist, t.title);
      if (!cached) continue;
      if (!t.keyName && !t.manualKey && cached.keyName) {
        t.keyName = cached.keyName;
        t.camelot = cached.camelot;
        t.keyText = cached.keyText;
      }
      if (!t.bpm && !t.manualBpm && cached.bpm) t.bpm = cached.bpm;
    }
  }
}

/** A manual key/BPM correction for one track, keyed by a stable id. */
interface TrackOverride {
  keyName: string;
  camelot: string;
  keyText: string;
  bpm: string;
  /**
   * Which fields this edit *asserted*, which is not the same as which fields it
   * filled in. Emptying a bogus BPM is a statement about the record just as
   * much as typing one is, and without recording it separately the clear would
   * be undone on the next reload by the value still sitting in tracks.txt.
   *
   * Optional because overrides written by earlier versions have no such field;
   * those read as "locked wherever a value is present", which is exactly what
   * the old code inferred.
   */
  manualKey?: boolean;
  manualBpm?: boolean;
}

/**
 * Which of a track's values the user has set by hand.
 *
 * A manual correction is the most authoritative thing in the collection: it is
 * someone who owns the record saying what is actually cut into it, against
 * whatever a catalogue or an audio analysis guessed. So the automated passes
 * must leave those fields alone — otherwise the next re-fetch silently reverts
 * the edit and commits the reversion to tracks.txt.
 *
 * The lock is per-field, because the two are edited independently: correcting a
 * BPM shouldn't stop a key being filled in later.
 *
 * It is carried on the track itself, having been read from tracks.txt (or set
 * by an edit in this session), so it is shared with every device that reads the
 * file rather than being one browser's private opinion.
 */
export interface ManualLock {
  key: boolean;
  bpm: boolean;
}

const NO_LOCK: ManualLock = { key: false, bpm: false };

const OVERRIDES_KEY = 'overrides.tracks';
const PENDING_KEY = 'pending.sync';

/**
 * A commit to GitHub that was attempted and did not land.
 *
 * The edit itself is never at risk — it is in `overrides.tracks` and re-applied
 * on every load — but until it reaches tracks.txt it exists on this device
 * only, and every other device will happily overwrite it. So the failure is
 * recorded durably rather than left in a message the user can navigate away
 * from, and retried until it lands.
 */
export interface PendingSync {
  /** Commit message of the write that failed, reused on the retry. */
  message: string;
  /** When the collection first went out of sync (ms since epoch). */
  since: number;
  /** How many times we have tried to push it. */
  attempts: number;
  /** Why the last attempt failed, shown to the user. */
  lastError: string;
}

/** How often an unsynced change is retried in the background. */
const RETRY_INTERVAL_MS = 60_000;

function loadPending(): PendingSync | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingSync) : null;
  } catch {
    return null;
  }
}

/** Stable id for a track across reloads (numeric ids are reassigned each load). */
function overrideId(releaseId: string, title: string, artist: string): string {
  return `${releaseId}\u0000${title}\u0000${artist}`.toLowerCase();
}

function loadOverrides(): Record<string, TrackOverride> {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, TrackOverride>) : {};
  } catch {
    return {};
  }
}

@Injectable({ providedIn: 'root' })
export class CollectionService {
  private readonly config = inject(ConfigService);

  /** Manual key/BPM corrections, applied on top of parsed/cached values. */
  private overrides = loadOverrides();

  readonly records = signal<Rec[]>([]);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * The change that has been made locally but has not reached GitHub yet.
   * Non-null means "this device is the only copy".
   */
  readonly pending = signal<PendingSync | null>(null);
  /** True while a retry is in flight, so the UI can show it and not stack up. */
  readonly syncing = signal(false);

  readonly tracks = computed<Track[]>(() =>
    this.records().flatMap((r) => r.tracks)
  );

  readonly allGenres = computed(() => uniqueSorted(this.records().flatMap((r) => r.genres)));
  readonly allStyles = computed(() => uniqueSorted(this.records().flatMap((r) => r.styles)));
  readonly allCamelot = computed(() =>
    uniqueSorted(this.tracks().map((t) => t.camelot).filter((c) => !!c)).sort(camelotSort)
  );

  constructor() {
    this.pending.set(loadPending());
    void this.reload();
    this.startRetryLoop();
  }

  /**
   * Keeps trying to land an unsynced change: whenever the machine comes back
   * online, whenever the tab is brought back to the front, and on a slow timer
   * for the case where connectivity returns without any event (a captive portal
   * or a flaky link, which is the usual reason a commit failed in the first
   * place).
   *
   * Also warns before the tab closes while a change is still local-only. That
   * is the one moment where "it's safe in localStorage" stops being reassuring:
   * the user may be about to close the browser on the machine that holds the
   * only copy.
   */
  private startRetryLoop(): void {
    if (typeof window === 'undefined') return;
    const attempt = () => void this.retrySync();
    window.addEventListener('online', attempt);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) attempt();
    });
    setInterval(attempt, RETRY_INTERVAL_MS);
    window.addEventListener('beforeunload', (e) => {
      if (!this.pending()) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  /**
   * Loads the latest tracks.txt: from the GitHub raw URL when a repo is
   * configured (freshest committed data), otherwise the bundled asset.
   */
  async reload(): Promise<void> {
    const cfg = this.config.config();
    let text: string | null = null;
    /**
     * Whether `text` is what GitHub actually holds. The bundled asset is a
     * build-time snapshot, so it must never be used as the baseline for the
     * comparison below — it would report drift that isn't there and, worse,
     * push stale data over the top of the real file.
     */
    let fromRemote = false;
    if (githubConfigured(cfg)) {
      try {
        const res = await fetch(rawUrl(cfg) + '?t=' + Date.now());
        if (res.ok) {
          text = await res.text();
          fromRemote = true;
        }
      } catch {
        /* fall through to the bundled asset */
      }
    }
    if (text == null) {
      try {
        const res = await fetch('assets/tracks.txt');
        if (res.ok) text = await res.text();
      } catch {
        /* ignore */
      }
    }
    if (text == null) {
      this.error.set('Could not load tracks.txt. Configure a GitHub repo or run "npm run sync-data".');
      this.loaded.set(true);
      return;
    }
    this.error.set(null);
    const records = parseTracksTxt(text);
    // Snapshot the committed values before anything local is layered on top.
    const committed = fromRemote ? signatures(records) : null;
    hydrateFromKeyCache(records);
    this.applyOverrides(records);
    this.setRecords(records);
    this.loaded.set(true);
    if (committed) this.reconcile(committed, records);
    // The local state is now fully rebuilt (file + caches + overrides), so a
    // change left unsynced by an earlier session can be pushed.
    if (this.pending()) void this.retrySync();
  }

  /**
   * Compares what GitHub holds against what this device believes, and queues a
   * push if they differ.
   *
   * This is what catches work that was already stranded before any of the
   * pending-change bookkeeping existed — an edit whose commit failed in an
   * earlier session, or a re-fetch run that filled in a hundred keys and then
   * couldn't write them. Those left no marker behind, so nothing would ever
   * have retried them; they would sit in this browser looking perfectly saved
   * until the day another device committed the old values back over them.
   *
   * It also works the other way round: if the file already matches, any pending
   * marker is stale — the change landed, or was committed from elsewhere — and
   * is cleared, so the warning bar can't get stuck on.
   *
   * The comparison is on values, not on file text: whitespace or field-order
   * differences between the Java exporter and `renderTracksTxt` would otherwise
   * read as permanent drift and cause a commit on every single load.
   */
  private reconcile(committed: string[], records: Rec[]): void {
    const local = signatures(records);
    let diverged = 0;
    for (let i = 0; i < local.length; i++) {
      if (local[i] !== committed[i]) diverged++;
    }
    if (local.length !== committed.length) diverged = Math.max(diverged, 1);

    if (!diverged) {
      if (this.pending()) this.markSynced();
      return;
    }
    if (this.pending()) return; // already queued; don't reset its age
    const what = diverged === 1 ? '1 track' : `${diverged} tracks`;
    this.markPending(
      `Sync local key/BPM changes (${what})`,
      'Found local changes that are not in tracks.txt yet.'
    );
  }

  /** Replaces the collection, re-indexing track ids and re-linking record facets. */
  setRecords(records: Rec[]): void {
    let id = 0;
    for (const r of records) {
      for (const t of r.tracks) {
        t.id = id++;
        t.recordTitle = r.title;
        t.recordArtist = r.artist;
        t.genres = r.genres;
        t.styles = r.styles;
        t.year = r.year;
        t.labels = r.labels;
        t.artwork = r.artwork;
        t.releaseId = r.releaseId;
      }
    }
    this.records.set([...records]);
  }

  trackById(id: number): Track | undefined {
    return this.tracks().find((t) => t.id === id);
  }

  /**
   * Applies stored manual overrides on top of parsed/cached values.
   *
   * The local override and the file's own `Manual:` flag are two records of the
   * same fact, and they are unioned rather than one replacing the other: an
   * edit made on this machine may not have reached GitHub yet, and a flag in
   * the file may have been committed from another machine that this browser has
   * never seen.
   */
  private applyOverrides(records: Rec[]): void {
    for (const r of records) {
      for (const t of r.tracks) {
        const o = this.overrides[overrideId(t.releaseId, t.title, t.artist)];
        if (!o) continue;
        t.keyName = o.keyName;
        t.camelot = o.camelot;
        t.keyText = o.keyText;
        t.bpm = o.bpm;
        t.manualKey = t.manualKey || (o.manualKey ?? !!(o.keyName || o.camelot));
        t.manualBpm = t.manualBpm || (o.manualBpm ?? !!o.bpm);
      }
    }
  }

  /**
   * Which of this track's values were set by hand, and so must not be
   * overwritten by a Beatport/tunebat pass.
   *
   * Only fields the user actually filled in are locked: someone who corrected
   * a BPM and left the key blank still wants the key looked up.
   */
  manualLock(t: Pick<Track, 'manualKey' | 'manualBpm'>): ManualLock {
    if (!t.manualKey && !t.manualBpm) return NO_LOCK;
    return { key: t.manualKey, bpm: t.manualBpm };
  }

  /** True when any part of this track was corrected by hand. */
  isManuallySet(t: Pick<Track, 'manualKey' | 'manualBpm'>): boolean {
    const lock = this.manualLock(t);
    return lock.key || lock.bpm;
  }

  /**
   * Drops the manual correction for a track, handing it back to the automated
   * lookups. The current values stay as they are until the next pass re-fetches
   * them, so nothing disappears from the screen.
   *
   * The flag has to be cleared in both places it lives — this browser's
   * overrides and the track itself — or the next commit would write the lock
   * straight back into tracks.txt.
   */
  clearManual(track: Track): void {
    const id = overrideId(track.releaseId, track.title, track.artist);
    const had = !!this.overrides[id] || track.manualKey || track.manualBpm;
    if (!had) return;
    delete this.overrides[id];
    track.manualKey = false;
    track.manualBpm = false;
    this.persistOverrides();
    this.records.set([...this.records()]);
    // Removing the flag changes tracks.txt, so it has to reach GitHub too —
    // otherwise the file keeps saying the field is hand-set and every other
    // device goes on skipping it.
    this.markPending(`Unlock ${track.title} — key/BPM`, 'Not pushed yet.');
    void this.retrySync();
  }

  private persistOverrides(): void {
    try {
      localStorage.setItem(OVERRIDES_KEY, JSON.stringify(this.overrides));
    } catch {
      /* ignore quota errors */
    }
  }

  /**
   * Sets a manual key/BPM correction for a track: updates it in memory, marks
   * the corrected fields as hand-set, and persists the override to localStorage
   * (re-applied on reload). Blank key + blank BPM clears any existing override.
   * Call `commitToGithub` to persist remotely — that is what carries the flag,
   * along with the value, to every other device.
   */
  setTrackKeyBpm(track: Track, keyName: string, camelot: string, bpm: string): void {
    keyName = (keyName || '').trim();
    camelot = (camelot || '').trim().toUpperCase();
    bpm = (bpm || '').trim();
    const keyText = keyName && camelot ? `${keyName} (${camelot})` : keyName;

    // A field is hand-set if the user put a value in it, *or* if they emptied
    // one that had a value. Clearing a bogus BPM is a correction like any
    // other, and without the lock the next automated pass — or the cached value
    // picked up on the next reload — would quietly put it back.
    const manualKey = !!keyText || (track.manualKey || !!track.keyText);
    const manualBpm = !!bpm || (track.manualBpm || !!track.bpm);

    // Update the live object so computed views recalc immediately.
    track.keyName = keyName;
    track.camelot = camelot;
    track.keyText = keyText;
    track.bpm = bpm;
    track.manualKey = manualKey;
    track.manualBpm = manualBpm;

    const id = overrideId(track.releaseId, track.title, track.artist);
    if (!keyName && !camelot && !bpm && !manualKey && !manualBpm) {
      delete this.overrides[id];
    } else {
      this.overrides[id] = { keyName, camelot, keyText, bpm, manualKey, manualBpm };
    }
    this.persistOverrides();
    // New array reference so signals (tracks/records) recompute.
    this.records.set([...this.records()]);
  }

  /** True when a GitHub repo + write token are configured. */
  canCommit(): boolean {
    const c = this.config.config();
    return githubConfigured(c) && !!c.githubToken;
  }

  /**
   * Commits the current collection to tracks.txt on GitHub — the same write a
   * real tunebat update uses — so manual edits are persisted remotely. Throws a
   * helpful error when GitHub isn't configured.
   *
   * Either way the outcome is recorded: success clears the pending marker, and
   * failure records one so the change is retried later instead of surviving
   * only as a message on a screen the user is about to leave.
   */
  async commitToGithub(message: string): Promise<void> {
    const cfg = this.config.config();
    if (!githubConfigured(cfg) || !cfg.githubToken) {
      this.markPending(message, 'GitHub is not configured.');
      throw new Error('Configure a GitHub repo and token in ⚙ Settings to save changes.');
    }
    try {
      const file = await getTracksFile(cfg); // current sha (null if the file is new)
      const text = renderTracksTxt(this.records());
      await putTracksFile(cfg, text, file?.sha, message);
      this.markSynced();
    } catch (e) {
      this.markPending(message, String(e));
      throw e;
    }
  }

  /** Records that local state has not reached GitHub, durably. */
  markPending(message: string, lastError: string): void {
    const prev = this.pending();
    const next: PendingSync = {
      message,
      // Keep the original timestamp: what matters is how long the collection
      // has been out of sync, not when the most recent attempt failed.
      since: prev?.since ?? Date.now(),
      attempts: (prev?.attempts ?? 0) + 1,
      lastError,
    };
    this.pending.set(next);
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota errors */
    }
  }

  /** Records that GitHub now holds the local state. */
  markSynced(): void {
    this.pending.set(null);
    try {
      localStorage.removeItem(PENDING_KEY);
    } catch {
      /* ignore */
    }
  }

  /**
   * Tries again to push the local collection. Safe to call at any time: it does
   * nothing when there is nothing pending, when a push is already running, or
   * when the browser knows it is offline.
   *
   * The sha is re-read immediately before the write, so a retry made minutes or
   * days later merges against whatever is in the repo now rather than failing
   * on a stale sha. Returns true when the change is safely on GitHub.
   */
  async retrySync(): Promise<boolean> {
    const p = this.pending();
    if (!p || this.syncing()) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    if (!this.canCommit()) return false;
    // Never overwrite tracks.txt with an empty file: a retry that fires before
    // the collection has finished loading would otherwise erase the lot.
    if (!this.records().length) return false;

    this.syncing.set(true);
    try {
      await this.commitToGithub(p.message);
      return true;
    } catch {
      return false; // already recorded by commitToGithub; try again later
    } finally {
      this.syncing.set(false);
    }
  }

  /** The exact tracks.txt that a commit would write, for offline backup. */
  renderCurrent(): string {
    return renderTracksTxt(this.records());
  }

  /** How the pending change should be described to the user. */

  pendingSummary(): string {
    const p = this.pending();
    if (!p) return '';
    const mins = Math.floor((Date.now() - p.since) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} h ago`;
    return `${Math.floor(hrs / 24)} d ago`;
  }
}

/**
 * One string per track capturing exactly the fields a commit would write, in
 * collection order.
 *
 * Only key, BPM and the two manual flags are included, because those are the
 * only things the app ever changes; everything else in tracks.txt comes from
 * Discogs and is rewritten identically. Comparing these instead of the file
 * text makes the check immune to formatting, which matters because the file may
 * have been written by the Java exporter rather than by `renderTracksTxt`.
 */
function signatures(records: Rec[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    for (const t of r.tracks) {
      out.push(
        `${t.keyText}\u0000${t.bpm}\u0000${t.manualKey ? 1 : 0}${t.manualBpm ? 1 : 0}`
      );
    }
  }
  return out;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function camelotSort(a: string, b: string): number {
  const pa = /^(\d{1,2})([AB])$/.exec(a);
  const pb = /^(\d{1,2})([AB])$/.exec(b);
  if (!pa || !pb) return a.localeCompare(b);
  const na = Number(pa[1]);
  const nb = Number(pb[1]);
  return na === nb ? pa[2].localeCompare(pb[2]) : na - nb;
}

