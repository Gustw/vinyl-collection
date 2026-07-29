# Vinyl Collection — harmonic mixing tool

A browser app for a **Discogs vinyl collection**, built around the question a DJ
actually has with a box of records in front of them: *what can I play next?*

It pulls the collection from Discogs, looks up each track's **musical key and
BPM**, and then answers the harmonic-mixing questions on top of that — which
records mix with this one, what a set's transitions will sound like, and how to
get from a record you're playing to a record you want to play.

Everything runs in the browser. There is no server: the collection lives in
`tracks.txt` in this repo, the app reads it over the GitHub raw URL, and writes
updates back through the GitHub API.

## What it does

- **Mixable tracks** — for any track, every record in the collection that mixes
  with it on the Camelot wheel, filterable by crate, genre, style, key and BPM.
- **Pitch-aware keys** — beat-matching a record transposes it, so keys are
  reported as the key a record *sounds in* at the tempo it is played at, not the
  key printed on the label. Half/double-tempo matching doesn't count as a pitch
  change.
- **Reachability** — mixes that need more pitch than your decks offer are marked
  as impossible rather than merely awkward (configurable; 8% for a stock
  Technics, 50% for most digital decks).
- **Crates** — named, ordered selections standing in for the box you actually
  carry to a gig. Bridge and mix suggestions can be limited to one.
- **Set builder** — puts a crate in playing order and lints every junction,
  separating mixes that can't be performed from ones that merely want an ear.
- **Bridge finder** — "I'm on this record, I want to reach that one, what takes
  me there?" Searches routes through the records you have, keeping every deck
  inside its pitch range and tracking where the set tempo ends up.

## Running it

```powershell
cd frontend
npm install
npm start
```

The app is also deployed to GitHub Pages by `.github/workflows/deploy.yml` on
every push to `main` that touches the app (data-only commits are skipped).

## Configuration

All settings live in the ⚙ panel and are stored in your browser's localStorage —
nothing is committed:

| Setting | What it does |
| --- | --- |
| Discogs user / token | Whose collection to import; a free token raises the rate limit from ~25 to 60 requests/min. |
| GitHub owner / repo / branch / path | Where `tracks.txt` is read from and written back to. |
| GitHub token | Needs `contents:write` so the in-app updater can commit. |
| CORS proxy | tunebat sends no CORS headers, so key lookups need a proxy — see [CORS-PROXY.md](CORS-PROXY.md). |
| Turntable pitch range | Decides which mixes are physically reachable. |
| Set tempo drift | How far the bridge finder may ride a set's tempo away from where it started. |

## Data

`tracks.txt` is the whole database — one block per record, human-readable and
diffable:

```
=== Welcome To The Jungle Volume 4 (Sampler One) -- DJ Deekline & Ed Solo ===
  ID: 9016487
  Genre: Electronic
  Style: Drum n Bass
  Year: 2016
  Label: Jungle Cakes
  Art: https://i.discogs.com/...jpeg
   1. Bad Boys (Benny Page Remix) - Ed Solo And Deekline [Key: D major (10B) | BPM: 105]
   2. Pass Me The Dubplate - Deekline Featuring Tippa Irie [Key: A# minor (3A) | BPM: 175]
```

Keys and BPMs are best-effort lookups and can be corrected by hand in the app;
an edit is written straight back to `tracks.txt`.

### Maintenance scripts

```powershell
cd frontend
npm run sync-data     # copy repo-root tracks.txt into src/assets (offline fallback)
npm run dedupe-data   # collapse duplicate record blocks, keeping the fullest copy
```

## Notes

- **tunebat rate-limits hard** (HTTP 429 with a 60s `Retry-After`). The updater
  honours it and backs off, so a first full import takes a while. Results are
  cached in localStorage, and tracks without a match are simply listed without a
  key.
- **Keys are normalised to ASCII** (`Bb`, `C#`) to avoid encoding issues in
  `tracks.txt`.
