import { Injectable, effect, signal } from '@angular/core';

/** All runtime configuration, persisted to localStorage (no server needed). */
export interface AppConfig {
  /** Discogs username whose collection is shown/updated. */
  discogsUser: string;
  /** Optional Discogs personal token (raises the API rate limit). */
  discogsToken: string;
  /** GitHub repo that stores tracks.txt (owner/repo/branch/path). */
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  tracksPath: string;
  /** Repo path of the crates file (playlists), stored next to tracks.txt. */
  cratesPath: string;
  /** GitHub token with `contents:write` on the repo (kept only in localStorage). */
  githubToken: string;
  /**
   * Optional CORS proxy prefix used for tunebat (which lacks CORS headers).
   * The target URL is appended URL-encoded, e.g.
   * `https://api.allorigins.win/raw?url=`.
   */
  corsProxy: string;
  /**
   * Pitch range of the turntables, in ± percent. Decides which mixes are
   * physically reachable: 8 for a stock Technics, 16 for the wide-range mode,
   * 50 for most digital decks.
   */
  pitchRange: number;
  /**
   * How far the tempo of a set may wander from where it started, in ± percent.
   * Bridging between two records with distant BPMs means riding the tempo up or
   * down through the records in between, so this is what decides how far the
   * bridge finder is willing to travel: 0 pins the set to one tempo, 8 lets it
   * move a fader's worth over the course of a route.
   */
  tempoDrift: number;
}

const STORAGE_KEY = 'app.config';

function detect(): Partial<AppConfig> {
  try {
    const m = /^([^.]+)\.github\.io$/.exec(location.hostname);
    const owner = m ? m[1] : '';
    const seg = location.pathname.split('/').filter(Boolean);
    const repo = m && seg.length ? seg[0] : '';
    return { githubOwner: owner, githubRepo: repo };
  } catch {
    return {};
  }
}

export function defaultConfig(): AppConfig {
  return {
    discogsUser: 'dunazov',
    discogsToken: '',
    githubOwner: '',
    githubRepo: '',
    githubBranch: 'main',
    tracksPath: 'tracks.txt',
    cratesPath: 'crates.json',
    githubToken: '',
    corsProxy: '',
    pitchRange: 8,
    tempoDrift: 6,
    ...detect(),
  };
}

@Injectable({ providedIn: 'root' })
export class ConfigService {
  readonly config = signal<AppConfig>(this.load());

  constructor() {
    effect(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config()));
      } catch {
        /* ignore */
      }
    });
  }

  update(patch: Partial<AppConfig>): void {
    this.config.set({ ...this.config(), ...patch });
  }

  private load(): AppConfig {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        return { ...defaultConfig(), ...(JSON.parse(raw) as Partial<AppConfig>) };
      }
    } catch {
      /* ignore */
    }
    return defaultConfig();
  }
}

