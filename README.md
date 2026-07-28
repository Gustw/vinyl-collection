# Discogs Vinyl → Tracklist + Key

A small, dependency-free Java tool that turns a **Discogs collection CSV export**
into a plain-text list of records, each with its tracklist (title + artist) and,
where available, the track's **musical key** (looked up on tunebat.com).

## How it works

1. Reads the CSV export (one row per record). It uses the `release_id` column.
2. For each record it calls the **Discogs API**
   (`https://api.discogs.com/releases/{release_id}`) to get the full tracklist.
3. For each track it queries **tunebat.com** for the musical key (best effort).
4. Writes the result to a text file.

Everything is in `src/Main.java` (includes a tiny CSV parser and JSON parser, so
there are no external libraries to install).

## Build & run (Zulu 21)

```powershell
$jdk = "C:\Program Files\Zulu\zulu-21"
& "$jdk\bin\javac.exe" -d out src\Main.java
& "$jdk\bin\java.exe" -cp out Main collection.csv tracks.txt
```

Arguments are optional and default to `collection.csv` → `tracks.txt`.

## Optional: Discogs token (recommended)

Anonymous Discogs access is rate-limited to ~25 requests/min. A free token raises
this to 60/min:

```powershell
$env:DISCOGS_TOKEN = "your_token_here"   # https://www.discogs.com/settings/developers
```

## Notes / limitations

- **tunebat rate limiting**: tunebat aggressively rate-limits its search API
  (HTTP 429, often with a 60s `Retry-After`). The tool honours this and retries
  with backoff, so a large collection can take a while. The key is optional —
  tracks without a match are simply listed without a key.
- **Corporate TLS proxies**: on Windows the tool trusts the OS certificate store
  (`Windows-ROOT`) so it works behind HTTPS-inspecting proxies without importing
  certificates into the JDK.
- Musical keys are normalised to ASCII (`Bb`, `C#`) to avoid text-encoding issues.

## Example output

```
=== This Is Augustus Pablo -- Augustus Pablo ===
   1. Dub Organizer - Augustus Pablo [Key: A minor (8A)]
   2. Please Sunrise - Augustus Pablo [Key: A# minor (3A)]
   3. Point Blank - Augustus Pablo [Key: A# minor (3A)]
   ...
```

