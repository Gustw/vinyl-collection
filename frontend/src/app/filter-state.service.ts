import { Injectable, effect, signal, WritableSignal } from '@angular/core';
import { defaultStickerPrefs } from './stickers';

export interface Filters {
  search: string;
  genres: string[];
  styles: string[];
  keys: string[]; // Camelot codes, e.g. "8A"
  /** Crate ids to restrict to (empty = the whole collection). */
  crates: string[];
  /** Whether the BPM-difference filter is active (detail view). */
  bpmEnabled: boolean;
  /** ± BPM tolerance from the reference track's BPM. */
  bpmRange: number;
  /** Also match tracks at double/half tempo (within the same tolerance). */
  bpmDoubleHalf: boolean;
  /** Detail view: show keys pitched to match BPM instead of their original key. */
  pitchAdjust: boolean;
  /**
   * Detail view: hide mixes that need more pitch than the turntables have
   * (i.e. physically impossible transitions).
   */
  pitchLimit: boolean;
  /** Detail view: relationship types toggled OFF (empty = all types shown). */
  hiddenTypes: string[];
  /** Overview: inclusive release-year lower bound (null = no bound). */
  yearMin: number | null;
  /** Overview: inclusive release-year upper bound (null = no bound). */
  yearMax: number | null;
}

export function emptyFilters(): Filters {
  return { search: '', genres: [], styles: [], keys: [], crates: [], bpmEnabled: true, bpmRange: 10, bpmDoubleHalf: true, pitchAdjust: false, pitchLimit: true, hiddenTypes: [], yearMin: null, yearMax: null };
}

export function hasActiveFilters(f: Filters): boolean {
  return (
    !!f.search ||
    f.genres.length > 0 ||
    f.styles.length > 0 ||
    f.keys.length > 0 ||
    f.crates.length > 0 ||
    f.hiddenTypes.length > 0 ||
    f.yearMin != null ||
    f.yearMax != null
  );
}

/**
 * How many filters other than the search box are active. Shown next to the
 * fold toggle so nothing looks "lost" while the filters are collapsed.
 */
export function activeFilterCount(f: Filters, scope: 'list' | 'detail'): number {
  let n = f.genres.length + f.styles.length + f.keys.length + f.crates.length;
  if (scope === 'list') {
    if (f.yearMin != null) n++;
    if (f.yearMax != null) n++;
  } else {
    n += f.hiddenTypes.length;
    if (f.bpmEnabled) n++;
    if (f.pitchAdjust) n++;
    if (f.pitchLimit) n++;
  }
  return n;
}

/** Overview display preferences (remembered across reloads). */
export interface ViewPrefs {
  /** Show each record's full tracklist, or just a compact record card. */
  showTracks: boolean;
  /** Compact-card arrangement: stacked list rows or a tile grid. */
  layout: 'list' | 'grid';
}

export function defaultViewPrefs(): ViewPrefs {
  return { showTracks: true, layout: 'list' };
}

/**
 * Holds the filter state for both screens and persists it to localStorage,
 * so filters are remembered when navigating between screens and across reloads.
 */
@Injectable({ providedIn: 'root' })
export class FilterStateService {
  /** Screen 1 (records list) filters. */
  readonly list = this.persisted('filters.list');
  /** Screen 2 (track detail / mixable list) filters. */
  readonly detail = this.persisted('filters.detail');
  /** Screen 1 overview display preferences. */
  readonly view = this.persistedView('view.list');
  /** Sticker sheet settings (tracks per sticker, sheet, margins…). */
  readonly stickers = this.persistedJson('stickers', defaultStickerPrefs);
  /**
   * Whether the filter panels are folded to just the search box. On a phone
   * they start folded: the genre/style/key chip lists run to several screens,
   * so leaving them open would bury the collection under its own filters.
   */
  readonly listCollapsed = this.persistedFlag('filters.list.collapsed');
  readonly detailCollapsed = this.persistedFlag('filters.detail.collapsed');

  /** Folds / unfolds a filter panel (everything except the search box). */
  toggleCollapsed(target: WritableSignal<boolean>): void {
    target.update((v) => !v);
  }

  /**
   * Starting state for a filter panel the user has never touched on this
   * device. Only ever a first-run default — an explicit choice is remembered
   * and always wins, on any screen size.
   */
  private defaultCollapsed(): boolean {
    try {
      return window.matchMedia('(max-width: 720px)').matches;
    } catch {
      return false;
    }
  }

  private persistedFlag(storageKey: string): WritableSignal<boolean> {
    let initial = this.defaultCollapsed();
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw !== null) initial = raw === 'true';
    } catch {
      /* ignore storage errors */
    }
    const sig = signal<boolean>(initial);
    effect(() => {
      try {
        localStorage.setItem(storageKey, String(sig()));
      } catch {
        /* ignore storage errors */
      }
    });
    return sig;
  }

  private persisted(storageKey: string): WritableSignal<Filters> {
    const sig = signal<Filters>(this.load(storageKey));
    effect(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(sig()));
      } catch {
        /* ignore storage errors */
      }
    });
    return sig;
  }

  private persistedView(storageKey: string): WritableSignal<ViewPrefs> {
    return this.persistedJson(storageKey, defaultViewPrefs);
  }

  /**
   * A signal of plain JSON state, loaded from and mirrored back to
   * localStorage. Stored values are merged over the defaults, so settings added
   * in a later version appear rather than coming back undefined.
   */
  private persistedJson<T extends object>(storageKey: string, fallback: () => T): WritableSignal<T> {
    let initial = fallback();
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) initial = { ...initial, ...(JSON.parse(raw) as Partial<T>) };
    } catch {
      /* ignore storage / parse errors */
    }
    const sig = signal<T>(initial);
    effect(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(sig()));
      } catch {
        /* ignore storage errors */
      }
    });
    return sig;
  }


  private load(storageKey: string): Filters {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        return { ...emptyFilters(), ...(JSON.parse(raw) as Partial<Filters>) };
      }
    } catch {
      /* ignore */
    }
    return emptyFilters();
  }

  /** Immutable toggle of a value inside one of the array facets. */
  toggle(target: WritableSignal<Filters>, facet: 'genres' | 'styles' | 'keys' | 'crates', value: string): void {
    const f = target();
    const set = new Set(f[facet]);
    set.has(value) ? set.delete(value) : set.add(value);
    target.set({ ...f, [facet]: [...set] });
  }

  setSearch(target: WritableSignal<Filters>, search: string): void {
    target.set({ ...target(), search });
  }

  /** Replaces the crate selection outright (e.g. "show only this crate"). */
  setCrates(target: WritableSignal<Filters>, crates: string[]): void {
    target.set({ ...target(), crates });
  }

  /** Enables/disables the BPM-difference filter. */
  setBpmEnabled(target: WritableSignal<Filters>, bpmEnabled: boolean): void {
    target.set({ ...target(), bpmEnabled });
  }

  /** Sets the ± BPM tolerance (negative values are clamped to 0 = exact match). */
  setBpmRange(target: WritableSignal<Filters>, range: number): void {
    const bpmRange = Number.isFinite(range) && range > 0 ? range : 0;
    target.set({ ...target(), bpmRange });
  }

  setBpmDoubleHalf(target: WritableSignal<Filters>, bpmDoubleHalf: boolean): void {
    target.set({ ...target(), bpmDoubleHalf });
  }

  setPitchAdjust(target: WritableSignal<Filters>, pitchAdjust: boolean): void {
    target.set({ ...target(), pitchAdjust });
  }

  /** Hides mixes needing more pitch than the turntables can give. */
  setPitchLimit(target: WritableSignal<Filters>, pitchLimit: boolean): void {
    target.set({ ...target(), pitchLimit });
  }

  /** Toggles a relationship type on/off (tracked as an exclude list). */
  toggleType(target: WritableSignal<Filters>, type: string): void {
    const f = target();
    const set = new Set(f.hiddenTypes);
    set.has(type) ? set.delete(type) : set.add(type);
    target.set({ ...f, hiddenTypes: [...set] });
  }

  /** Sets the release-year lower/upper bounds (null clears a bound). */
  setYearMin(target: WritableSignal<Filters>, year: number | null): void {
    target.set({ ...target(), yearMin: Number.isFinite(year as number) ? year : null });
  }

  setYearMax(target: WritableSignal<Filters>, year: number | null): void {
    target.set({ ...target(), yearMax: Number.isFinite(year as number) ? year : null });
  }

  clear(target: WritableSignal<Filters>): void {
    target.set(emptyFilters());
  }
}

