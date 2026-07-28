import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { CollectionService } from './collection.service';
import { ConfigService } from './config.service';
import { Crate, Track, trackKey } from './models';
import { canWrite, getFile, githubConfigured, putFile } from './github';

const STORAGE_KEY = 'crates.v1';

/** Shape of the crates file committed to the repo. */
interface CratesFile {
  version: 1;
  crates: Crate[];
}

function parseCrates(text: string): Crate[] {
  try {
    const data = JSON.parse(text) as Partial<CratesFile>;
    if (!data || !Array.isArray(data.crates)) return [];
    return data.crates
      .filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string')
      .map((c) => ({
        id: c.id,
        name: c.name,
        trackKeys: Array.isArray(c.trackKeys) ? c.trackKeys.map(String) : [],
      }));
  } catch {
    return [];
  }
}

function renderCrates(crates: Crate[]): string {
  const file: CratesFile = { version: 1, crates };
  return JSON.stringify(file, null, 2) + '\n';
}

function newId(): string {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Crates: named, ordered selections of tracks used to prepare a gig.
 *
 * They live in a JSON file next to tracks.txt in the same GitHub repo, and are
 * mirrored to localStorage so edits survive a reload (and work offline) even
 * before they have been committed.
 */
@Injectable({ providedIn: 'root' })
export class CrateService {
  private readonly col = inject(CollectionService);
  private readonly config = inject(ConfigService);

  readonly crates = signal<Crate[]>(this.loadLocal());
  readonly saving = signal(false);
  readonly status = signal('');
  readonly error = signal<string | null>(null);

  /** Blob sha of the crates file, so commits update instead of clobbering. */
  private sha: string | undefined;

  constructor() {
    // Mirror every change to localStorage.
    effect(() => {
      try {
        localStorage.setItem(STORAGE_KEY, renderCrates(this.crates()));
      } catch {
        /* ignore storage errors */
      }
    });
    void this.reload();
  }

  /** Loads the committed crates file, falling back to the local mirror. */
  async reload(): Promise<void> {
    const cfg = this.config.config();
    if (!githubConfigured(cfg)) return;
    try {
      const file = await getFile(cfg, cfg.cratesPath);
      if (file) {
        this.sha = file.sha;
        this.crates.set(parseCrates(file.text));
      }
    } catch {
      /* offline or no access: keep the local mirror */
    }
  }

  private loadLocal(): Crate[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? parseCrates(raw) : [];
    } catch {
      return [];
    }
  }

  byId(id: string): Crate | undefined {
    return this.crates().find((c) => c.id === id);
  }

  /** All crates a track belongs to. */
  cratesOf(t: Track): Crate[] {
    const key = trackKey(t);
    return this.crates().filter((c) => c.trackKeys.includes(key));
  }

  contains(crateId: string, t: Track): boolean {
    return !!this.byId(crateId)?.trackKeys.includes(trackKey(t));
  }

  /**
   * Resolves a crate's keys to the tracks currently in the collection, keeping
   * the crate's order. Keys with no match (record sold, title changed) are
   * dropped from the result but kept in the crate, so they reappear if the
   * record comes back.
   */
  tracksOf(crateId: string): Track[] {
    const crate = this.byId(crateId);
    if (!crate) return [];
    const byKey = new Map<string, Track>();
    for (const t of this.col.tracks()) {
      const k = trackKey(t);
      if (!byKey.has(k)) byKey.set(k, t); // first copy wins for doubles
    }
    return crate.trackKeys.map((k) => byKey.get(k)).filter((t): t is Track => !!t);
  }

  /** Track keys in a crate that no longer resolve to anything owned. */
  missingCount(crateId: string): number {
    const crate = this.byId(crateId);
    if (!crate) return 0;
    return crate.trackKeys.length - this.tracksOf(crateId).length;
  }

  create(name: string): Crate {
    const crate: Crate = { id: newId(), name: name.trim() || 'New crate', trackKeys: [] };
    this.crates.update((list) => [...list, crate]);
    void this.commit(`Add crate "${crate.name}"`);
    return crate;
  }

  rename(id: string, name: string): void {
    const clean = name.trim();
    if (!clean) return;
    this.crates.update((list) => list.map((c) => (c.id === id ? { ...c, name: clean } : c)));
    void this.commit(`Rename crate to "${clean}"`);
  }

  remove(id: string): void {
    const name = this.byId(id)?.name ?? '';
    this.crates.update((list) => list.filter((c) => c.id !== id));
    void this.commit(`Delete crate "${name}"`);
  }

  /** Adds a track to the end of a crate (no-op when already in it). */
  add(crateId: string, t: Track): void {
    const key = trackKey(t);
    let changed = false;
    this.crates.update((list) =>
      list.map((c) => {
        if (c.id !== crateId || c.trackKeys.includes(key)) return c;
        changed = true;
        return { ...c, trackKeys: [...c.trackKeys, key] };
      })
    );
    if (changed) void this.commit(`Add ${t.artist} - ${t.title} to crate`);
  }

  removeTrack(crateId: string, t: Track): void {
    const key = trackKey(t);
    this.crates.update((list) =>
      list.map((c) => (c.id === crateId ? { ...c, trackKeys: c.trackKeys.filter((k) => k !== key) } : c))
    );
    void this.commit(`Remove ${t.artist} - ${t.title} from crate`);
  }

  toggle(crateId: string, t: Track): void {
    this.contains(crateId, t) ? this.removeTrack(crateId, t) : this.add(crateId, t);
  }

  /** Moves the entry at `from` to `to`, keeping the rest of the order. */
  move(crateId: string, from: number, to: number): void {
    const crate = this.byId(crateId);
    if (!crate) return;
    const keys = [...crate.trackKeys];
    if (from < 0 || from >= keys.length || to < 0 || to >= keys.length || from === to) return;
    const [moved] = keys.splice(from, 1);
    keys.splice(to, 0, moved);
    this.crates.update((list) => list.map((c) => (c.id === crateId ? { ...c, trackKeys: keys } : c)));
    void this.commit('Reorder crate');
  }

  /** Replaces a crate's order outright (used by the set builder). */
  setOrder(crateId: string, trackKeys: string[]): void {
    this.crates.update((list) => list.map((c) => (c.id === crateId ? { ...c, trackKeys } : c)));
    void this.commit('Reorder crate');
  }

  /** Commits the crates file; silently stays local when no token is set. */
  private async commit(message: string): Promise<void> {
    const cfg = this.config.config();
    if (!canWrite(cfg)) {
      this.status.set('Saved on this device (add a GitHub token to sync crates).');
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      this.sha = await putFile(cfg, cfg.cratesPath, renderCrates(this.crates()), this.sha, message);
      this.status.set('Crates saved to GitHub.');
    } catch (e) {
      // A stale sha means someone else changed the file; re-read and retry once.
      try {
        const file = await getFile(cfg, cfg.cratesPath);
        this.sha = file?.sha;
        this.sha = await putFile(
          cfg,
          cfg.cratesPath,
          renderCrates(this.crates()),
          this.sha,
          message
        );
        this.status.set('Crates saved to GitHub.');
      } catch (e2) {
        this.error.set('Crates saved on this device, but the GitHub commit failed: ' + e2);
      }
    } finally {
      this.saving.set(false);
    }
  }
}

/** Convenience: does this track belong to any of the given crate ids? */
export function inAnyCrate(crates: Crate[], ids: string[], t: Track): boolean {
  if (!ids.length) return true;
  const key = trackKey(t);
  return crates.some((c) => ids.includes(c.id) && c.trackKeys.includes(key));
}

