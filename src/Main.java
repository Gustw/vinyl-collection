import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.security.KeyStore;
import java.util.Map;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

/**
 * Discogs vinyl collection -> per-record tracklists with (optional) musical key.
 *
 * <p>Pipeline:
 * <ol>
 *   <li>Read a Discogs CSV collection export (one row per record/release).</li>
 *   <li>For each record, fetch its tracklist from the Discogs API
 *       (https://api.discogs.com/releases/{release_id}).</li>
 *   <li>For each track, look up its musical key on tunebat.com (best effort).</li>
 *   <li>Write a plain-text list of records -> tracks (title, artist, optional key).</li>
 * </ol>
 *
 * <p>Usage: {@code java Main [inputCsv] [outputTxt]}<br>
 * Defaults: {@code collection.csv} -> {@code tracks.txt}.
 *
 * <p>Optional: set environment variable {@code DISCOGS_TOKEN} to raise the
 * Discogs API rate limit (25 -> 60 requests/min). Get a free token at
 * https://www.discogs.com/settings/developers .
 */
public class Main {

    // Column indexes for a standard Discogs collection CSV export:
    // Catalog#,Artist,Title,Label,Format,Rating,Released,release_id,CollectionFolder,...
    private static final int COL_ARTIST = 1;
    private static final int COL_TITLE = 2;
    private static final int COL_RELEASE_ID = 7;

    private static final String USER_AGENT =
            "DiscogsVinylKeyFinder/1.0 +https://example.local";

    private static final HttpClient HTTP = buildHttpClient();

    /**
     * Builds an HttpClient. On Windows we trust the OS certificate store
     * ("Windows-ROOT") so that corporate TLS-inspection proxies (which re-sign
     * HTTPS with a custom root CA trusted by Windows but not by the JDK) work
     * without manually importing certs into the JDK's cacerts.
     */
    private static HttpClient buildHttpClient() {
        HttpClient.Builder builder = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(15))
                .followRedirects(HttpClient.Redirect.NORMAL);
        try {
            if (System.getProperty("os.name", "").toLowerCase().contains("win")) {
                KeyStore ks = KeyStore.getInstance("Windows-ROOT");
                ks.load(null, null);
                TrustManagerFactory tmf = TrustManagerFactory.getInstance(
                        TrustManagerFactory.getDefaultAlgorithm());
                tmf.init(ks);
                SSLContext ctx = SSLContext.getInstance("TLS");
                ctx.init(null, tmf.getTrustManagers(), null);
                builder.sslContext(ctx);
            }
        } catch (Exception e) {
            System.err.println("Warning: could not use Windows trust store, "
                    + "falling back to JDK default: " + e.getMessage());
        }
        return builder.build();
    }

    record Track(String title, String artist, String key, String bpm) {
    }

    record Record(String releaseId, String artist, String title,
                  List<String> genres, List<String> styles, int year, List<String> labels,
                  String artwork, List<Track> tracks) {
    }

    /** What we pull back from a single Discogs release lookup. */
    record DiscogsInfo(List<String[]> tracks, List<String> genres, List<String> styles,
                       int year, List<String> labels, String artwork, boolean fromNetwork) {
    }

    /** Key + BPM for a track (either may be empty). */
    record KeyInfo(String key, String bpm) {
    }

    /** Where found keys are persisted between runs; set in main(). */
    private static Path keyCacheFile;

    /** Held for the JVM lifetime while a run owns the output file (see acquireRunLock). */
    private static java.io.RandomAccessFile runLockRaf;
    private static java.nio.channels.FileLock runLock;
    private static Path runLockPath;

    /** Directory of cached raw Discogs release JSON, so re-runs skip Discogs. */
    private static final Path DISCOGS_CACHE_DIR = Path.of("cache", "discogs");

    /**
     * When set (env {@code KEYS_CACHE_ONLY=1} or {@code -DkeysCacheOnly=true}),
     * tunebat is never contacted: keys/BPM come solely from the on-disk cache.
     * Useful to quickly rebuild the export (e.g. after adding new fields) without
     * spending hours re-hitting the rate-limited tunebat API.
     */
    private static final boolean CACHE_ONLY =
            "1".equals(System.getenv("KEYS_CACHE_ONLY")) || Boolean.getBoolean("keysCacheOnly");

    public static void main(String[] args) throws Exception {
        Path input = Path.of(args.length > 0 ? args[0] : "collection.csv");
        Path output = Path.of(args.length > 1 ? args[1] : "tracks.txt");

        if (!Files.exists(input)) {
            System.err.println("Input CSV not found: " + input.toAbsolutePath());
            System.err.println("Usage: java Main [inputCsv] [outputTxt]");
            return;
        }

        String discogsToken = System.getenv("DISCOGS_TOKEN");
        if (discogsToken == null || discogsToken.isBlank()) {
            System.out.println("Note: DISCOGS_TOKEN not set -> using anonymous Discogs "
                    + "access (lower rate limit).");
        }

        // Guard: refuse to start if another run already owns this output file.
        // Concurrent runs would interleave writes and duplicate records.
        if (!acquireRunLock(output)) {
            System.err.println("Another run is already writing " + output.toAbsolutePath()
                    + " (lock: " + runLockPath.getFileName() + ").");
            System.err.println("Refusing to start a second run to avoid duplicating records. "
                    + "Wait for it to finish (or stop it) and retry.");
            return;
        }

        // Persistent caches make re-runs cheap: found keys and fetched releases are
        // reused, so a second run only spends time on tracks still missing a key.
        keyCacheFile = Path.of(output + ".keys.tsv");
        int loaded = loadKeyCache(keyCacheFile);
        if (loaded > 0) {
            System.out.println("Loaded " + loaded + " cached key(s) from "
                    + keyCacheFile.getFileName() + " (already-found keys will be reused).");
        }

        List<String[]> rows = readRecords(input);
        System.out.println("Read " + rows.size() + " record(s) from " + input.getFileName());

        // Start with an empty file so a crash still leaves a partial export.
        Files.writeString(output, "", StandardCharsets.UTF_8,
                java.nio.file.StandardOpenOption.CREATE,
                java.nio.file.StandardOpenOption.TRUNCATE_EXISTING);

        int i = 0;
        for (String[] row : rows) {
            i++;
            String artist = cleanArtist(row[0]);
            String title = row[1].trim();
            String releaseId = row[2].trim();

            System.out.printf("[%d/%d] %s - %s (id=%s)%n", i, rows.size(), title, artist, releaseId);

            List<Track> tracks = new ArrayList<>();
            List<String> genres = new ArrayList<>();
            List<String> styles = new ArrayList<>();
            int year = 0;
            List<String> labels = new ArrayList<>();
            String artwork = "";
            boolean discogsHitNetwork = false;
            try {
                DiscogsInfo info = fetchDiscogsRelease(releaseId, artist, discogsToken);
                discogsHitNetwork = info.fromNetwork();
                genres = info.genres();
                styles = info.styles();
                year = info.year();
                labels = info.labels();
                artwork = info.artwork();
                for (String[] rt : info.tracks()) {
                    String tTitle = rt[0];
                    String tArtist = rt[1];
                    String key = "";
                    String bpm = "";
                    try {
                        KeyInfo ki = lookupKey(tArtist, tTitle);
                        key = ki.key();
                        bpm = ki.bpm();
                    } catch (Exception e) {
                        System.err.println("    tunebat lookup failed for \"" + tTitle
                                + "\": " + e.getMessage());
                    }
                    tracks.add(new Track(tTitle, tArtist, key, bpm));
                }
            } catch (Exception e) {
                System.err.println("  Discogs lookup failed for id " + releaseId + ": "
                        + e.getMessage());
            }

            // Append this record immediately so we always have a partial export on failure.
            List<String> lines = renderRecord(
                    new Record(releaseId, artist, title, genres, styles, year, labels, artwork, tracks));
            Files.write(output, lines, StandardCharsets.UTF_8,
                    java.nio.file.StandardOpenOption.CREATE,
                    java.nio.file.StandardOpenOption.APPEND);

            // Only pace Discogs when we actually hit the network (cached re-runs fly).
            if (discogsHitNetwork) {
                Thread.sleep(discogsToken == null || discogsToken.isBlank() ? 2500 : 1100);
            }
        }

        long missing = countMissingKeys(output);
        System.out.println("\nWrote output to " + output.toAbsolutePath());
        if (missing > 0) {
            System.out.println(missing + " track(s) still have no key. Re-run the same "
                    + "command later to retry only those (found keys are cached).");
        }
    }

    /**
     * Acquires an exclusive OS file lock so only one run writes {@code output}
     * at a time. Returns {@code false} if another live run already holds it.
     *
     * <p>Uses {@link java.nio.channels.FileChannel#tryLock()} on a sibling
     * {@code <output>.lock} file. The OS releases the lock automatically when
     * the process exits (even on crash), so a stale lock file never blocks a
     * future run. A shutdown hook also tidies up the lock file on clean exit.
     */
    private static boolean acquireRunLock(Path output) {
        runLockPath = Path.of(output + ".lock");
        try {
            runLockRaf = new java.io.RandomAccessFile(runLockPath.toFile(), "rw");
            java.nio.channels.FileChannel ch = runLockRaf.getChannel();
            java.nio.channels.FileLock lock;
            try {
                lock = ch.tryLock();
            } catch (java.nio.channels.OverlappingFileLockException e) {
                lock = null; // already locked within this JVM (shouldn't happen)
            }
            if (lock == null) {
                runLockRaf.close();
                runLockRaf = null;
                return false;
            }
            runLock = lock;
            // Record who holds it (informational only).
            ch.truncate(0);
            String info = "pid=" + ProcessHandle.current().pid()
                    + " started=" + java.time.Instant.now() + System.lineSeparator();
            runLockRaf.write(info.getBytes(StandardCharsets.UTF_8));
            Runtime.getRuntime().addShutdownHook(new Thread(Main::releaseRunLock));
            return true;
        } catch (IOException e) {
            // If we can't create/lock the file, proceed rather than block the user.
            System.err.println("Warning: could not create run lock (" + e.getMessage()
                    + "); proceeding without it.");
            return true;
        }
    }

    /** Releases the run lock and removes the lock file (best effort). */
    private static void releaseRunLock() {
        try {
            if (runLock != null) {
                runLock.release();
            }
        } catch (IOException ignored) {
            // ignore
        }
        try {
            if (runLockRaf != null) {
                runLockRaf.close();
            }
        } catch (IOException ignored) {
            // ignore
        }
        try {
            if (runLockPath != null) {
                Files.deleteIfExists(runLockPath);
            }
        } catch (IOException ignored) {
            // ignore
        }
    }

    /** Counts track lines in the output that don't yet have a [Key: ...]. */
    private static long countMissingKeys(Path output) throws IOException {        long missing = 0;
        for (String line : Files.readAllLines(output, StandardCharsets.UTF_8)) {
            if (line.matches("\\s+\\d+\\..*") && !line.contains("[Key:")) {
                missing++;
            }
        }
        return missing;
    }

    // -------------------- Output rendering --------------------

    private static List<String> renderRecord(Record r) {
        List<String> lines = new ArrayList<>();
        lines.add("=== " + r.title() + " -- " + r.artist() + " ===");
        if (!r.genres().isEmpty()) {
            lines.add("  Genre: " + String.join(", ", r.genres()));
        }
        if (!r.styles().isEmpty()) {
            lines.add("  Style: " + String.join(", ", r.styles()));
        }
        if (r.year() > 0) {
            lines.add("  Year: " + r.year());
        }
        if (!r.labels().isEmpty()) {
            lines.add("  Label: " + String.join(", ", r.labels()));
        }
        if (r.artwork() != null && !r.artwork().isBlank()) {
            lines.add("  Art: " + r.artwork());
        }
        if (r.tracks().isEmpty()) {
            lines.add("  (no tracks found)");
        } else {
            int n = 0;
            for (Track t : r.tracks()) {
                n++;
                StringBuilder sb = new StringBuilder();
                sb.append(String.format("  %2d. %s - %s", n, t.title(), t.artist()));
                boolean hasKey = t.key() != null && !t.key().isBlank();
                boolean hasBpm = t.bpm() != null && !t.bpm().isBlank();
                if (hasKey || hasBpm) {
                    sb.append(" [");
                    if (hasKey) {
                        sb.append("Key: ").append(t.key());
                    }
                    if (hasBpm) {
                        if (hasKey) {
                            sb.append(" | ");
                        }
                        sb.append("BPM: ").append(t.bpm());
                    }
                    sb.append(']');
                }
                lines.add(sb.toString());
            }
        }
        lines.add("");
        return lines;
    }

    // -------------------- CSV --------------------

    /** Returns rows as {artist, title, releaseId}. */
    private static List<String[]> readRecords(Path input) throws IOException {
        List<String[]> records = new ArrayList<>();
        List<String> raw = Files.readAllLines(input, StandardCharsets.UTF_8);

        boolean headerSkipped = false;
        for (String line : raw) {
            if (line.isBlank()) {
                continue;
            }
            List<String> f = parseCsvLine(line);
            if (!headerSkipped) {
                headerSkipped = true; // first non-empty line is the header
                continue;
            }
            if (f.size() <= COL_RELEASE_ID) {
                continue;
            }
            records.add(new String[]{f.get(COL_ARTIST), f.get(COL_TITLE), f.get(COL_RELEASE_ID)});
        }
        return records;
    }

    /** Minimal RFC-4180-ish CSV parser: handles quoted fields and escaped quotes. */
    private static List<String> parseCsvLine(String line) {
        List<String> out = new ArrayList<>();
        StringBuilder sb = new StringBuilder();
        boolean inQuotes = false;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (inQuotes) {
                if (c == '"') {
                    if (i + 1 < line.length() && line.charAt(i + 1) == '"') {
                        sb.append('"');
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    sb.append(c);
                }
            } else if (c == '"') {
                inQuotes = true;
            } else if (c == ',') {
                out.add(sb.toString());
                sb.setLength(0);
            } else {
                sb.append(c);
            }
        }
        out.add(sb.toString());
        return out;
    }

    /** Discogs disambiguates artists with a trailing "(2)" etc. Strip that. */
    private static String cleanArtist(String artist) {
        return artist.trim().replaceAll("\\s*\\(\\d+\\)$", "").trim();
    }

    // -------------------- Discogs API --------------------

    /** Fetches tracklist plus genres/styles for a release. */
    @SuppressWarnings("unchecked")
    private static DiscogsInfo fetchDiscogsRelease(String releaseId, String fallbackArtist,
                                                   String token)
            throws IOException, InterruptedException {
        if (releaseId == null || releaseId.isBlank() || !releaseId.matches("\\d+")) {
            throw new IOException("no valid release_id");
        }

        // Serve from the on-disk cache if we've fetched this release before.
        Path cacheFile = DISCOGS_CACHE_DIR.resolve(releaseId + ".json");
        String body;
        boolean fromNetwork;
        if (Files.exists(cacheFile)) {
            body = Files.readString(cacheFile, StandardCharsets.UTF_8);
            fromNetwork = false;
        } else {
            String url = "https://api.discogs.com/releases/" + releaseId;
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(25))
                    .header("Accept", "application/json")
                    .header("User-Agent", USER_AGENT);
            if (token != null && !token.isBlank()) {
                b.header("Authorization", "Discogs token=" + token.trim());
            }
            HttpResponse<String> resp = HTTP.send(b.GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() != 200) {
                throw new IOException("HTTP " + resp.statusCode());
            }
            body = resp.body();
            Files.createDirectories(DISCOGS_CACHE_DIR);
            Files.writeString(cacheFile, body, StandardCharsets.UTF_8);
            fromNetwork = true;
        }

        Object json = new Json(body).parse();
        if (!(json instanceof Map)) {
            throw new IOException("unexpected JSON");
        }
        Map<String, Object> release = (Map<String, Object>) json;

        String releaseArtist = joinArtists(release.get("artists"), fallbackArtist);
        List<String> genres = stringList(release.get("genres"));
        List<String> styles = stringList(release.get("styles"));
        int year = extractYear(release);
        List<String> labels = extractLabels(release);
        String artwork = extractArtwork(release);

        List<String[]> tracks = new ArrayList<>();
        Object tl = release.get("tracklist");
        if (tl instanceof List<?> list) {
            for (Object o : list) {
                if (!(o instanceof Map)) {
                    continue;
                }
                Map<String, Object> entry = (Map<String, Object>) o;
                String type = str(entry.get("type_"));
                // Skip headings / index tracks without a real title.
                if (!type.isEmpty() && !type.equals("track")) {
                    continue;
                }
                String title = str(entry.get("title")).trim();
                if (title.isEmpty()) {
                    continue;
                }
                String trackArtist = joinArtists(entry.get("artists"), releaseArtist);
                tracks.add(new String[]{title, trackArtist});
            }
        }
        return new DiscogsInfo(tracks, genres, styles, year, labels, artwork, fromNetwork);
    }

    /** Release year from the {@code year} field, falling back to {@code released}'s leading year. */
    private static int extractYear(Map<String, Object> release) {
        Object y = release.get("year");
        if (y instanceof Number n && n.intValue() > 0) {
            return n.intValue();
        }
        String released = str(release.get("released")).trim();
        if (released.length() >= 4) {
            String head = released.substring(0, 4);
            if (head.chars().allMatch(Character::isDigit)) {
                return Integer.parseInt(head);
            }
        }
        return 0;
    }

    /** Record label name(s), de-duplicated and with Discogs "(2)" suffixes stripped. */
    @SuppressWarnings("unchecked")
    private static List<String> extractLabels(Map<String, Object> release) {
        java.util.LinkedHashSet<String> seen = new java.util.LinkedHashSet<>();
        Object labels = release.get("labels");
        if (labels instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map) {
                    String name = str(((Map<String, Object>) o).get("name"))
                            .replaceAll("\\s*\\(\\d+\\)$", "").trim();
                    if (!name.isEmpty()) {
                        seen.add(name);
                    }
                }
            }
        }
        return new ArrayList<>(seen);
    }

    /** Picks a cover image URL: primary release image, else any image, else thumb. */
    @SuppressWarnings("unchecked")
    private static String extractArtwork(Map<String, Object> release) {
        Object imgs = release.get("images");
        if (imgs instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map && "primary".equals(str(((Map<String, Object>) o).get("type")))) {
                    String u = str(((Map<String, Object>) o).get("uri"));
                    if (!u.isBlank()) return u;
                }
            }
            for (Object o : list) {
                if (o instanceof Map) {
                    String u = str(((Map<String, Object>) o).get("uri"));
                    if (!u.isBlank()) return u;
                }
            }
        }
        return str(release.get("thumb"));
    }

    /** Converts a JSON array of strings into a List (empty if absent). */
    private static List<String> stringList(Object arr) {
        List<String> out = new ArrayList<>();
        if (arr instanceof List<?> list) {
            for (Object o : list) {
                String s = str(o).trim();
                if (!s.isEmpty()) {
                    out.add(s);
                }
            }
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static String joinArtists(Object artistsObj, String fallback) {
        if (!(artistsObj instanceof List<?> list) || list.isEmpty()) {
            return fallback;
        }
        StringBuilder sb = new StringBuilder();
        for (Object o : list) {
            if (!(o instanceof Map)) {
                continue;
            }
            Map<String, Object> a = (Map<String, Object>) o;
            String name = str(a.get("anv"));
            if (name.isBlank()) {
                name = str(a.get("name"));
            }
            name = name.replaceAll("\\s*\\(\\d+\\)$", "").trim();
            sb.append(name);
            String join = str(a.get("join")).trim();
            if (!join.isEmpty() && !join.equals(",")) {
                sb.append(' ').append(join).append(' ');
            } else if (!join.isEmpty()) {
                sb.append(join).append(' ');
            }
        }
        String result = sb.toString().trim();
        return result.isBlank() ? fallback : result;
    }

    private static String str(Object o) {
        return o == null ? "" : o.toString();
    }

    // -------------------- Tunebat lookup --------------------

    /**
     * In-memory cache of term -> "key\tbpm" (either field may be empty) so repeated
     * queries don't hit the API twice.
     */
    private static final Map<String, String> KEY_CACHE = new java.util.HashMap<>();

    /** Loads previously found keys from disk (tab-separated: term \t key [\t bpm]). */
    private static int loadKeyCache(Path file) throws IOException {
        if (file == null || !Files.exists(file)) {
            return 0;
        }
        int n = 0;
        for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
            String[] p = line.split("\t", -1);
            if (p.length < 2 || p[0].isEmpty()) {
                continue;
            }
            String key = p[1];
            String bpm = p.length > 2 ? p[2] : "";
            KEY_CACHE.put(p[0], key + "\t" + bpm);
            n++;
        }
        return n;
    }

    /** Appends a found key (+bpm) to the on-disk cache so future runs reuse it. */
    private static void persistKey(String term, String key, String bpm) {
        if (keyCacheFile == null) {
            return;
        }
        try {
            Files.writeString(keyCacheFile,
                    term + "\t" + key + "\t" + bpm + System.lineSeparator(),
                    StandardCharsets.UTF_8,
                    java.nio.file.StandardOpenOption.CREATE,
                    java.nio.file.StandardOpenOption.APPEND);
        } catch (IOException e) {
            // Non-fatal: caching is an optimisation.
        }
    }

    /** Returns key + BPM of the best tunebat match ("" fields if none). */
    private static KeyInfo lookupKey(String artist, String title)
            throws IOException, InterruptedException {
        String term = (artist + " " + title).trim();
        String fallbackKey = "";
        if (KEY_CACHE.containsKey(term)) {
            String v = KEY_CACHE.get(term);
            int t = v.indexOf('\t');
            String key = t < 0 ? v : v.substring(0, t);
            String bpm = t < 0 ? "" : v.substring(t + 1);
            if (!bpm.isBlank()) {
                return new KeyInfo(key, bpm); // fully cached (key + bpm)
            }
            fallbackKey = key; // key known but bpm missing -> try to enrich this run
        }
        // Cache-only mode: never hit the network; return whatever the cache had.
        if (CACHE_ONLY) {
            return new KeyInfo(fallbackKey, "");
        }
        String url = "https://api.tunebat.com/api/tracks/search?term="
                + URLEncoder.encode(term, StandardCharsets.UTF_8);

        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(20))
                .header("Accept", "application/json")
                // Origin/Referer are required or Cloudflare returns HTTP 403.
                .header("Origin", "https://tunebat.com")
                .header("Referer", "https://tunebat.com/")
                .header("User-Agent",
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                                + "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
                .GET()
                .build();

        try {
            HttpResponse<String> response = sendWithRetry(request, 5);
            if (response.statusCode() != 200) {
                throw new IOException("HTTP " + response.statusCode());
            }
            KeyInfo ki = parseKeyInfo(new Json(response.body()).parse());
            if (!ki.key().isBlank()) {
                KEY_CACHE.put(term, ki.key() + "\t" + ki.bpm());
                persistKey(term, ki.key(), ki.bpm()); // misses stay uncached -> retried
                Thread.sleep(350); // be polite to tunebat after an actual network call
                return ki;
            }
            Thread.sleep(350);
            // Empty result this time: never drop a key we already knew.
            if (!fallbackKey.isBlank()) {
                return new KeyInfo(fallbackKey, "");
            }
            return ki;
        } catch (IOException e) {
            // If we already had a key from a previous run, keep it even if this
            // enrichment attempt failed (e.g. rate-limited); just without BPM.
            if (!fallbackKey.isBlank()) {
                return new KeyInfo(fallbackKey, "");
            }
            throw e;
        }
    }

    @SuppressWarnings("unchecked")
    private static KeyInfo parseKeyInfo(Object json) {
        if (!(json instanceof Map)) {
            return new KeyInfo("", "");
        }
        Object data = ((Map<String, Object>) json).get("data");
        if (!(data instanceof Map)) {
            return new KeyInfo("", "");
        }
        Object items = ((Map<String, Object>) data).get("items");
        if (!(items instanceof List<?> list) || list.isEmpty()) {
            return new KeyInfo("", "");
        }
        Object first = list.get(0);
        if (!(first instanceof Map)) {
            return new KeyInfo("", "");
        }
        Map<String, Object> item = (Map<String, Object>) first;
        String key = str(item.get("k")).trim();       // e.g. "G major", "B♭ major"
        String camelot = str(item.get("c")).trim();    // e.g. "9B"
        String bpm = "";
        if (item.get("b") instanceof Number num) {
            long rounded = Math.round(num.doubleValue());
            if (rounded > 0) {
                bpm = Long.toString(rounded);
            }
        }
        if (key.isEmpty()) {
            return new KeyInfo("", bpm);
        }
        // Normalise ♭/♯ to ASCII (Bb / C#) so output is encoding-safe everywhere.
        key = key.replace("\u266d", "b").replace("\u266f", "#");
        String keyText = camelot.isEmpty() ? key : key + " (" + camelot + ")";
        return new KeyInfo(keyText, bpm);
    }

    /**
     * Sends a request, retrying on 429 (Too Many Requests) / 503 with a backoff
     * that honours the {@code Retry-After} header when present. Tunebat rate-limits
     * aggressively, so this keeps the run going instead of dropping tracks.
     */
    private static HttpResponse<String> sendWithRetry(HttpRequest request, int maxAttempts)
            throws IOException, InterruptedException {
        HttpResponse<String> response = null;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
            int code = response.statusCode();
            if (code != 429 && code != 503) {
                return response;
            }
            if (attempt == maxAttempts) {
                break;
            }
            long waitMs = response.headers().firstValue("Retry-After")
                    .map(v -> {
                        try {
                            return Long.parseLong(v.trim()) * 1000L;
                        } catch (NumberFormatException e) {
                            return -1L;
                        }
                    })
                    .filter(v -> v > 0)
                    .orElse((long) Math.min(30_000, 3_000 * (1L << (attempt - 1)))); // 3s,6s,12s,24s
            System.out.println("    rate-limited (HTTP " + code + "), waiting "
                    + (waitMs / 1000) + "s...");
            Thread.sleep(waitMs);
        }
        return response;
    }

    // -------------------- Tiny JSON parser --------------------

    /** Minimal recursive-descent JSON parser (objects, arrays, strings, numbers, bool, null). */
    private static final class Json {
        private final String s;
        private int i;

        Json(String s) {
            this.s = s;
        }

        Object parse() {
            Object v = readValue();
            return v;
        }

        private Object readValue() {
            skipWs();
            char c = peek();
            switch (c) {
                case '{': return readObject();
                case '[': return readArray();
                case '"': return readString();
                case 't': case 'f': return readBool();
                case 'n': expect("null"); return null;
                default: return readNumber();
            }
        }

        private Map<String, Object> readObject() {
            java.util.LinkedHashMap<String, Object> map = new java.util.LinkedHashMap<>();
            i++; // {
            skipWs();
            if (peek() == '}') { i++; return map; }
            while (true) {
                skipWs();
                String key = readString();
                skipWs();
                i++; // :
                Object val = readValue();
                map.put(key, val);
                skipWs();
                char c = peek();
                i++;
                if (c == '}') break;
                // c == ',' -> continue
            }
            return map;
        }

        private List<Object> readArray() {
            List<Object> list = new ArrayList<>();
            i++; // [
            skipWs();
            if (peek() == ']') { i++; return list; }
            while (true) {
                list.add(readValue());
                skipWs();
                char c = peek();
                i++;
                if (c == ']') break;
                // c == ',' -> continue
            }
            return list;
        }

        private String readString() {
            StringBuilder sb = new StringBuilder();
            i++; // opening quote
            while (true) {
                char c = s.charAt(i++);
                if (c == '"') break;
                if (c == '\\') {
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'u':
                            String hex = s.substring(i, i + 4);
                            i += 4;
                            sb.append((char) Integer.parseInt(hex, 16));
                            break;
                        default: sb.append(e);
                    }
                } else {
                    sb.append(c);
                }
            }
            return sb.toString();
        }

        private Object readNumber() {
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) {
                i++;
            }
            String num = s.substring(start, i);
            try {
                if (num.contains(".") || num.contains("e") || num.contains("E")) {
                    return Double.parseDouble(num);
                }
                return Long.parseLong(num);
            } catch (NumberFormatException e) {
                return num;
            }
        }

        private Boolean readBool() {
            if (peek() == 't') {
                expect("true");
                return Boolean.TRUE;
            }
            expect("false");
            return Boolean.FALSE;
        }

        private void expect(String word) {
            if (!s.startsWith(word, i)) {
                throw new IllegalStateException("Expected '" + word + "' at " + i);
            }
            i += word.length();
        }

        private void skipWs() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
                i++;
            }
        }

        private char peek() {
            return s.charAt(i);
        }
    }
}