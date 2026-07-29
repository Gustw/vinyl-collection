import { AppConfig } from './config.service';

/** A single release entry from a user's Discogs collection. */
export interface CollectionEntry {
  releaseId: string;
  title: string;
  artist: string;
  genres: string[];
  styles: string[];
  year: number;
  labels: string[];
  artwork: string;
}

/** Release detail we need: tracklist plus the record-level facets. */
export interface ReleaseDetail {
  tracks: { title: string; artist: string; position: string; duration: string }[];
  genres: string[];
  styles: string[];
  year: number;
  labels: string[];
  artwork: string;
}

const API = 'https://api.discogs.com';

function withToken(url: string, cfg: AppConfig): string {
  const t = cfg.discogsToken.trim();
  if (!t) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status !== 200) throw new Error('Discogs HTTP ' + res.status);
  return res.json();
}

function stripNum(s: string): string {
  return (s || '').replace(/\s*\(\d+\)$/, '').trim();
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => !!v)));
}

/** Joins a Discogs artists array into a display string (mirrors the Java tool). */
export function joinArtists(artists: any, fallback = ''): string {
  if (!Array.isArray(artists) || !artists.length) return fallback;
  let out = '';
  for (const a of artists) {
    let name = stripNum(String(a?.anv || '') || String(a?.name || ''));
    out += name;
    const join = String(a?.join || '').trim();
    if (join && join !== ',') out += ' ' + join + ' ';
    else if (join) out += join + ' ';
  }
  return out.trim() || fallback;
}

function labelsOf(labels: any): string[] {
  if (!Array.isArray(labels)) return [];
  return uniq(labels.map((l) => stripNum(String(l?.name || ''))));
}

function artworkOf(release: any): string {
  const imgs = release?.images;
  if (Array.isArray(imgs)) {
    const primary = imgs.find((i) => i?.type === 'primary' && i?.uri);
    if (primary) return String(primary.uri);
    const any = imgs.find((i) => i?.uri);
    if (any) return String(any.uri);
  }
  return String(release?.thumb || '');
}

function yearOf(release: any): number {
  const y = Number(release?.year);
  if (y > 0) return y;
  const rel = String(release?.released || '').trim();
  if (rel.length >= 4 && /^\d{4}/.test(rel)) return Number(rel.slice(0, 4));
  return 0;
}

/** Fetches every page of the user's collection (folder 0 = All). */
export async function fetchCollection(
  cfg: AppConfig,
  onPage?: (page: number, pages: number) => void,
  pace?: () => Promise<unknown>
): Promise<CollectionEntry[]> {
  const out: CollectionEntry[] = [];
  let page = 1;
  let pages = 1;
  do {
    const url = withToken(
      `${API}/users/${encodeURIComponent(cfg.discogsUser)}/collection/folders/0/releases?per_page=100&page=${page}&sort=added&sort_order=desc`,
      cfg
    );
    const data = await getJson(url);
    pages = Number(data?.pagination?.pages) || 1;
    onPage?.(page, pages);
    for (const r of data?.releases || []) {
      const bi = r?.basic_information || {};
      out.push({
        releaseId: String(r?.id ?? bi?.id ?? ''),
        title: String(bi?.title || ''),
        artist: joinArtists(bi?.artists),
        genres: Array.isArray(bi?.genres) ? bi.genres.map(String) : [],
        styles: Array.isArray(bi?.styles) ? bi.styles.map(String) : [],
        year: Number(bi?.year) || 0,
        labels: labelsOf(bi?.labels),
        artwork: String(bi?.cover_image || bi?.thumb || ''),
      });
    }
    page++;
    if (page <= pages && pace) await pace();
  } while (page <= pages);
  return out;
}

/** Fetches (and caches) a release's detail, returning tracklist + facets. */
export async function fetchReleaseDetail(
  cfg: AppConfig,
  releaseId: string
): Promise<ReleaseDetail> {
  const cacheKey = 'discogs.release.' + releaseId;
  let release: any = null;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      release = JSON.parse(cached);
    } catch {
      release = null;
    }
  }
  let fromNetwork = false;
  if (!release) {
    release = await getJson(withToken(`${API}/releases/${releaseId}`, cfg));
    fromNetwork = true;
    try {
      localStorage.setItem(cacheKey, JSON.stringify(release));
    } catch {
      /* localStorage may be full; ignore */
    }
  }

  const releaseArtist = joinArtists(release?.artists);
  const tracks: ReleaseDetail['tracks'] = [];
  const tl = release?.tracklist;
  if (Array.isArray(tl)) {
    for (const entry of tl) {
      const type = String(entry?.type_ || '');
      if (type && type !== 'track') continue;
      const title = String(entry?.title || '').trim();
      if (!title) continue;
      tracks.push({
        title,
        artist: joinArtists(entry?.artists, releaseArtist),
        // Discogs positions are user-entered and the case is inconsistent — the
        // same collection has both "A1" and "a". Folded up so a column of them
        // reads as a column.
        position: String(entry?.position || '').trim().toUpperCase(),
        duration: String(entry?.duration || '').trim(),
      });
    }
  }
  (release as any).__fromNetwork = fromNetwork;
  return {
    tracks,
    genres: Array.isArray(release?.genres) ? release.genres.map(String) : [],
    styles: Array.isArray(release?.styles) ? release.styles.map(String) : [],
    year: yearOf(release),
    labels: labelsOf(release?.labels),
    artwork: artworkOf(release),
  };
}

/** True when the release detail was served from network (for pacing). */
export function wasReleaseCached(releaseId: string): boolean {
  return localStorage.getItem('discogs.release.' + releaseId) != null;
}

