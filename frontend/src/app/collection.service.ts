import { Injectable, computed, inject, signal } from '@angular/core';
import { Rec, Track } from './models';
import { ConfigService } from './config.service';
import { githubConfigured, getTracksFile, putTracksFile, rawUrl } from './github';
import { renderTracksTxt } from './tracks-format';
import { cachedKeyInfo } from './tunebat';

const HEADER_RE = /^===\s(.*)\s===$/;
const TRACK_RE = /^\s*\d+\.\s+(.*)$/;
const KEY_RE = /\s*\[Key:\s*([^\]]+)\]\s*$/;
const CAMELOT_RE = /\((\d{1,2}[AB])\)/;

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
      let body = tr[1].trim();
      let keyText = '';
      let keyName = '';
      let camelot = '';
      let bpm = '';
      const km = KEY_RE.exec(body);
      if (km) {
        let content = km[1].trim();
        body = body.replace(KEY_RE, '').trim();
        const bm = /\|\s*BPM:\s*([\d.]+)/i.exec(content);
        if (bm) {
          bpm = bm[1];
          content = content.replace(/\s*\|\s*BPM:.*$/i, '').trim();
        }
        keyText = content;
        const cm = CAMELOT_RE.exec(keyText);
        camelot = cm ? cm[1] : '';
        keyName = keyText.replace(/\s*\([^)]*\)\s*$/, '').trim();
      }
      // Split "Title - Artist" on the LAST " - " (artists rarely contain it).
      const idx = body.lastIndexOf(' - ');
      const title = idx >= 0 ? body.slice(0, idx).trim() : body.trim();
      const artist = idx >= 0 ? body.slice(idx + 3).trim() : current.artist;

      current.tracks.push({
        id: id++,
        title,
        artist,
        keyName,
        camelot,
        keyText,
        bpm,
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
 * Fills in any missing key/BPM on parsed records from the tunebat localStorage
 * cache. This restores update progress after a page reload even when it hasn't
 * been committed to GitHub yet (e.g. no token configured, or a refresh between
 * commit checkpoints). Existing values are never overwritten.
 */
export function hydrateFromKeyCache(records: Rec[]): void {
  for (const r of records) {
    for (const t of r.tracks) {
      if (t.keyName && t.bpm) continue;
      const cached = cachedKeyInfo(t.artist, t.title);
      if (!cached) continue;
      if (!t.keyName && cached.keyName) {
        t.keyName = cached.keyName;
        t.camelot = cached.camelot;
        t.keyText = cached.keyText;
      }
      if (!t.bpm && cached.bpm) t.bpm = cached.bpm;
    }
  }
}

/** A manual key/BPM correction for one track, keyed by a stable id. */
interface TrackOverride {
  keyName: string;
  camelot: string;
  keyText: string;
  bpm: string;
}

const OVERRIDES_KEY = 'overrides.tracks';

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

  readonly tracks = computed<Track[]>(() =>
    this.records().flatMap((r) => r.tracks)
  );

  readonly allGenres = computed(() => uniqueSorted(this.records().flatMap((r) => r.genres)));
  readonly allStyles = computed(() => uniqueSorted(this.records().flatMap((r) => r.styles)));
  readonly allCamelot = computed(() =>
    uniqueSorted(this.tracks().map((t) => t.camelot).filter((c) => !!c)).sort(camelotSort)
  );

  constructor() {
    void this.reload();
  }

  /**
   * Loads the latest tracks.txt: from the GitHub raw URL when a repo is
   * configured (freshest committed data), otherwise the bundled asset.
   */
  async reload(): Promise<void> {
    const cfg = this.config.config();
    let text: string | null = null;
    if (githubConfigured(cfg)) {
      try {
        const res = await fetch(rawUrl(cfg) + '?t=' + Date.now());
        if (res.ok) text = await res.text();
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
    hydrateFromKeyCache(records);
    this.applyOverrides(records);
    this.setRecords(records);
    this.loaded.set(true);
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

  /** Applies stored manual overrides on top of parsed/cached values. */
  private applyOverrides(records: Rec[]): void {
    for (const r of records) {
      for (const t of r.tracks) {
        const o = this.overrides[overrideId(t.releaseId, t.title, t.artist)];
        if (!o) continue;
        t.keyName = o.keyName;
        t.camelot = o.camelot;
        t.keyText = o.keyText;
        t.bpm = o.bpm;
      }
    }
  }

  /**
   * Sets a manual key/BPM correction for a track: updates it in memory and
   * persists the override to localStorage (re-applied on reload). Blank key +
   * blank BPM clears any existing override. Call `commitToGithub` to persist
   * remotely.
   */
  setTrackKeyBpm(track: Track, keyName: string, camelot: string, bpm: string): void {
    keyName = (keyName || '').trim();
    camelot = (camelot || '').trim().toUpperCase();
    bpm = (bpm || '').trim();
    const keyText = keyName && camelot ? `${keyName} (${camelot})` : keyName;

    // Update the live object so computed views recalc immediately.
    track.keyName = keyName;
    track.camelot = camelot;
    track.keyText = keyText;
    track.bpm = bpm;

    const id = overrideId(track.releaseId, track.title, track.artist);
    if (!keyName && !camelot && !bpm) {
      delete this.overrides[id];
    } else {
      this.overrides[id] = { keyName, camelot, keyText, bpm };
    }
    try {
      localStorage.setItem(OVERRIDES_KEY, JSON.stringify(this.overrides));
    } catch {
      /* ignore quota errors */
    }
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
   */
  async commitToGithub(message: string): Promise<void> {
    const cfg = this.config.config();
    if (!githubConfigured(cfg) || !cfg.githubToken) {
      throw new Error('Configure a GitHub repo and token in ⚙ Settings to save changes.');
    }
    const file = await getTracksFile(cfg); // current sha (null if the file is new)
    const text = renderTracksTxt(this.records());
    await putTracksFile(cfg, text, file?.sha, message);
  }
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

