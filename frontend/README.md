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

## Key & pitch cheat sheet (🎹 on both screens)
A reference card, not a calculator. Opens on the current track's key from the
detail screen, or 8A from the list; tap any key to re-point it. Three parts:

- **What mixes with this key, and why** — every compatible key with its
  relationship (same key, ±1 energy, relative, same root, ±1/±2 semitones) and a
  sentence on what that move actually does to a set.
- **What the pitch fader does to the key** — the table that motivates the whole
  thing: **±6% per semitone**, and a semitone is **seven positions** round the
  Camelot wheel, not one. Rungs beyond your configured pitch range are marked
  unreachable.
- **The wheel** — all 24 codes against their musical key names.

On a phone each row breaks so the badges sit on one line and the explanation
below them, rather than being squeezed into a column two words wide.

## Sticker sheets (🏷 on screen 1)
Generates a print-ready PDF of sleeve labels from the **filtered** track list —
whatever the list is showing is what gets printed, so narrow it down first
(a crate, a genre, a BPM band) rather than printing 900 tracks.

- **2 or 4 tracks per sticker.** A record with more matching tracks than fit
  simply continues onto the next sticker, numbered `1/2`, `2/2`. A record never
  shares a sticker with another one — a label has to make sense on one sleeve.
  Type size comes from the *configured* slot count, not from how many tracks a
  sticker happens to hold, so a leftover single track is set exactly like a full
  sticker and leaves its unused rows blank rather than ballooning to fill them.
- **Top line:** `year · label · record name`, the provenance in grey and the
  record name in bold. No artist — on a sleeve you already know whose record it
  is, and the space buys a readable title. Only the first imprint is shown, and
  it is capped at 45% of the line so a long label can't crowd out the name.
- **Sheets:** the gapless 70 × 37 mm 24-up sheet (most own-brand packs) and
  Avery L7159 / J8159 (63.5 × 33.9 mm). Both are 3 × 8 on A4.
- **Edge safety margin** (default 2 mm) keeps text away from the die-cut edge,
  absorbing the millimetre or two brands differ by and the drift of a printer
  that doesn't register perfectly.
- **Skip labels** lets you start part-way down a sheet you've already used.
- **Outlines** draws the label boundaries for a test print on plain paper.

All of these are remembered in `localStorage` alongside the filters and view
preferences, so the sheet you settled on is still set next time.

Print at **100% / actual size** — "fit to page" shrinks the sheet by a few
millimetres and everything walks off the labels.

The PDF is written by `pdf.ts`, a ~250-line writer using the standard Helvetica
fonts. That's deliberate: the app is a static bundle and the only thing needed
is "put this string at this coordinate", which isn't worth 300 kB of jsPDF.

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

