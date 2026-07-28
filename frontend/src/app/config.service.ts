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
  /** GitHub token with `contents:write` on the repo (kept only in localStorage). */
  githubToken: string;
  /**
   * Optional CORS proxy prefix used for tunebat (which lacks CORS headers).
   * The target URL is appended URL-encoded, e.g.
   * `https://api.allorigins.win/raw?url=`.
   */
  corsProxy: string;
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
    githubToken: '',
    corsProxy: '',
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

