# Vinyl Collection front-end (Angular)

A small Angular 18 (standalone + signals) app that reads the `tracks.txt` export
produced by the Java tool and lets you browse and mix your collection.

## Screens
- **Screen 1 – Records & tracks:** every record with its genre/style and tracks.
  Search box + multi-select filters (genres, styles, Camelot keys). Click a track
  to open its detail.
- **Screen 2 – Track detail + mixable keys:** full track info, plus a list of all
  other tracks in **harmonically compatible keys** (Camelot wheel: same key, ±1,
  and the relative major/minor). That list is itself searchable and filterable.

Filters on both screens are **remembered** (kept when navigating between screens
and persisted to `localStorage` across reloads). Each screen keeps its own set.

## Data & updating (no server — runs entirely in the browser)
The app loads `tracks.txt` at runtime. When a GitHub repo is configured it reads
the live file from `raw.githubusercontent.com`; otherwise it falls back to the
bundled `src/assets/tracks.txt`.

The **⟳ Update collection** button (top-right of the overview) does everything the
old Java tool did, but client-side:
1. Fetches the full Discogs collection of the configured user (`dunazov` by default).
2. For each release, fetches its tracklist/genres/styles/year/labels/artwork from Discogs.
3. Looks up each track's key + BPM on tunebat.
4. **Merges** into `tracks.txt` (existing records keep their keys/BPM; only new
   records and corrections/additions are applied — the file is never wiped) and
   commits it back to GitHub via the REST API.

The button is greyed out while running. Hover it to see progress
(records processed / total, and how many keys/BPM are still missing); when idle
the tooltip shows the current missing counts. The list updates live as data comes in.

### Configuration (⚙ settings)
Open the ⚙ panel and set:
- **Discogs user** (default `dunazov`) and an optional **Discogs token** (higher rate limit).
- **GitHub owner / repo / branch / path** — auto-detected on `*.github.io`.
- **GitHub token** with `contents:write` on the repo (needed to save updates).
- **CORS proxy for tunebat** — tunebat has no CORS headers, so browser calls are
  blocked unless routed through a proxy (e.g. `https://api.allorigins.win/raw?url=`).
  Without one, Discogs data still loads but keys/BPM stay missing.

All tokens are stored only in your browser's `localStorage`.

Discogs release JSON and tunebat results are cached in `localStorage`, so re-runs
only spend time on records/tracks that still need data.

To bundle a fresh snapshot into the app assets from a local `tracks.txt`:

```powershell
npm run sync-data
```

## Run

```powershell
cd C:\DEV\testing\frontend
npm install
npm start        # opens http://localhost:4200
```

## Deploy to GitHub Pages

```powershell
npm run build:pages     # relative base href, hash routing
```

Publish the contents of `dist/vinyl-frontend/browser` to GitHub Pages (e.g. via a
GitHub Action or the `gh-pages` branch). Because routing uses hash URLs, deep
links work without any server rewrites.

## Notes
- Routing uses hash URLs (`/#/track/12`) so it also works when opened as static
  files after `npm run build`.
- Track ids are positional (based on order in `tracks.txt`), so deep links can
  shift if the export is regenerated with a different track order.
- Harmonic-mix rules live in `src/app/camelot.ts` if you want to widen/narrow the
  compatible set.

