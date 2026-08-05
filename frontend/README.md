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
- **Each track row:** position (`A1`) · key badge · title · BPM, with the artist
  and printed length on a second line. The position column sizes itself to the
  widest code on that sticker and disappears entirely when none of its tracks
  have one, so a record without positions doesn't pay for the column.
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
3. Looks up each track's key + BPM on Beatport, falling back to tunebat for
   anything Beatport doesn't carry.
4. **Merges** into `tracks.txt` (existing records keep their keys/BPM; only new
   records and corrections/additions are applied — the file is never wiped) and
   commits it back to GitHub via the REST API.

The button is greyed out while running. Hover it to see progress
(records processed / total, and how many keys/BPM are still missing); when idle
the tooltip shows the current missing counts. The list updates live as data comes in.

Two repair passes sit next to it:

- **↻ Re-fetch keys / BPM** re-asks both sources for every track, ignoring the
  cache, and overwrites whatever comes back different.
- **◆ Beatport keys / BPM** does the same against Beatport *only*. It exists
  because the values already in the collection were produced by tunebat's audio
  analysis, so the normal chain would fall back to tunebat on every miss and
  largely re-confirm them; this pass replaces them with the label's published
  figures and leaves anything Beatport doesn't carry untouched.

Both are cancellable, commit as they go, and remember where they stopped so the
next run resumes instead of re-checking thousands of tracks. Each keeps its own
cursor. Neither will touch a key or BPM you corrected by hand — see below.

### Detect key & BPM by listening (🎤 on the track page)

For records the online sources have never heard of — white labels, private
presses, anything pre-internet — the track page can work the key and tempo out
by ear. Play the record, press **🎤 Detect by listening**, and it records a
fragment through the device microphone and analyses it.

Nothing is ever saved automatically: the dialog *proposes*, showing its own
confidence and every caveat, and you confirm. Key and BPM are ticked
separately, so you can accept the tempo and reject the key.

The engine is [essentia.js](https://mtg.github.io/essentia.js/) — the
WebAssembly build of Essentia, the music information retrieval library from the
Music Technology Group at UPF. Because any single estimator will occasionally be
confidently wrong, nothing here trusts one answer:

- **Key** is estimated with three chroma profiles (`edma`, trained on electronic
  dance music, plus `bgate` and `temperley`), again over each third of the
  fragment, and once more restricted to the low register — where the bassline
  settles the tonic. Those seven estimates then vote in two stages: first *which
  notes* (the Camelot number, which is what harmonic mixing is computed from),
  then *which mode* (the A/B letter). Counting them separately means the dialog
  can say "certainly an 8, probably 8A" instead of one muddy number.
- **Tempo** comes from `RhythmExtractor2013` in multifeature mode — a committee
  of five beat trackers that reports how much they agreed — cross-checked
  against `PercivalBpmEstimator` over the whole fragment and each half.
  Half/double-time disagreement is reconciled rather than counted as a conflict,
  and offered as a one-click alternative.

Anything the analysis is not sure about arrives **un-ticked**, so accepting the
defaults is always the cautious choice. Silent, clipped or too-short recordings
are refused outright rather than guessed at.

For a usable reading: drop the needle on a steady part of the track (past the
intro, not on a breakdown), **set the pitch fader to zero** — otherwise you are
measuring the pitched key and tempo — and record for 30 seconds or more. All
browser voice processing (echo cancellation, noise suppression, automatic gain
control) is switched off during capture, because it is tuned for speech and
wrecks music analysis.

Accepting a result saves it exactly like a hand edit, so it is protected from
the automatic passes on every device (see below).

Microphone capture needs a secure page: **https://** or `localhost`.

`npm run check:analysis` runs the whole pipeline offline against a synthetic
signal of known key and tempo, plus the silent and too-short cases.

### Manual corrections win
Editing a track's key/BPM — by hand or by confirming a 🎤 analysis — marks those
fields as **hand-set**, and the automatic passes treat them as authoritative and
never overwrite them. Protection is per-field: correcting only the BPM still
lets a key be looked up. A track with both set by hand is skipped without a
request. The track page shows a **✎ set by hand** badge and an **↺ Unlock**
button to hand it back to the lookups.

The flag is written into `tracks.txt` next to the value, as a `Manual` field in
the track's metadata block:

```
   1. Original Nuttah - Shy FX [Pos: A1 | Time: 5:23 | Key: A minor (8A) | BPM: 175 | Manual: key,bpm]
```

so it travels with the collection: a re-fetch run from a different browser or
device sees the lock too and leaves the correction alone. (Before this, the flag
lived only in `localStorage`, so another device would happily "correct" a
hand-checked value and commit the reversion.)

The edit is *also* kept in `localStorage` — keyed by release + title + artist —
which covers the window before it reaches GitHub: no token configured, a failed
commit, or a reload in between. The two are unioned on load, so neither can lose
a lock the other knows about.

Every field in the metadata block is optional in both directions, and unknown
fields are read past rather than choked on, so files written by older or newer
versions all still read correctly.

### Configuration (⚙ settings)
Open the ⚙ panel and set:
- **Discogs user** (default `dunazov`) and an optional **Discogs token** (higher rate limit).
- **GitHub owner / repo / branch / path** — auto-detected on `*.github.io`.
- **GitHub token** with `contents:write` on the repo (needed to save updates).
- **CORS proxy for Beatport / tunebat** — neither has CORS headers, so browser
  calls are blocked unless routed through a proxy (e.g.
  `https://api.allorigins.win/raw?url=`). Without one, Discogs data still loads
  but keys/BPM stay missing. See [CORS-PROXY.md](../CORS-PROXY.md).
- **Beatport API token** — optional. With one, Beatport is read through its
  documented v4 API; without one, through its public search page. Only sent as an
  `Authorization` header, so the proxy has to forward that header for it to help.

All tokens are stored only in your browser's `localStorage`.

Discogs release JSON and both sources' results are cached in `localStorage` (under
separate namespaces, so the two can't be confused), so re-runs only spend time on
records/tracks that still need data.

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

`npm install`, `npm start` and `npm run build` each copy the essentia.js
WebAssembly runtime into `src/assets/essentia/` (see
`scripts/copy-essentia.mjs`). It is served as a static asset rather than
bundled, so it is not committed — the copy step keeps it in step with the
version in `package.json`.

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
- essentia.js (the microphone analysis engine) is **AGPL-3.0**. It is loaded as a
  separate, unmodified asset and only when you actually use the 🎤 feature, but
  if you redistribute a build, that licence applies to it.

