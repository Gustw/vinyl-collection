# Adding a CORS proxy for Beatport and tunebat

The app fetches keys/BPM from **Beatport** (primary) and **tunebat** (fallback)
directly in your browser. Neither sends CORS headers, so the browser blocks the
responses and keys/BPM stay empty. (Discogs data still loads fine — it allows
CORS.)

To fix this you point the app at a **CORS proxy**: a tiny service that fetches
them server-side and re-serves the response *with* CORS headers.

## How the app uses the value

The app builds each request as:

```
<CORS proxy prefix> + encodeURIComponent("https://www.beatport.com/search/tracks?q=...")
```

So the value you paste **must end where a URL-encoded URL should be appended** —
in practice it ends with `?url=` (or similar).

Where to paste it: click the **⚙ (settings)** button in the app → field
**"CORS proxy for Beatport / tunebat (prefix)"**. It's saved in your browser
only (localStorage).

### Which hosts it needs to reach

| Host | Used for |
|------|----------|
| `www.beatport.com` | the public search page (no credentials needed) |
| `api.beatport.com` | the v4 API, only when you set a Beatport token |
| `api.tunebat.com` | the fallback lookup |

---

## Option A — Quick test with a public proxy (not reliable long-term)

1. Open the app and click **⚙**.
2. In **CORS proxy for Beatport / tunebat**, paste:
   ```
   https://api.allorigins.win/raw?url=
   ```
3. Close settings and click **⟳ Update collection**. Keys/BPM should start
   filling in.

> Public proxies are rate-limited, slow, and can disappear without notice. They
> also generally **strip the `Authorization` header**, so a Beatport API token
> won't work through one — the app falls back to the public search page, which
> is fine. Use them only to confirm the flow works, then switch to your own
> (Option B).

---

## Option B — Your own Cloudflare Worker (recommended, free)

This gives you a fast, private, reliable proxy on a free Cloudflare account.

### 1. Create the Worker
1. Sign in at <https://dash.cloudflare.com> (create a free account if needed).
2. Left sidebar → **Workers & Pages** → **Create** → **Create Worker**.
3. Give it a name (e.g. `music-proxy`) → **Deploy** (a hello-world worker is
   created).
4. Click **Edit code**.

### 2. Paste this code
Replace the default code with the following, then **Deploy**:

```js
// Hosts this proxy is willing to fetch, so it can't be abused as an open proxy.
const ALLOWED = new Set([
  "www.beatport.com",
  "api.beatport.com",
  "api.tunebat.com",
  "tunebat.com",
]);

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      // Authorization must be allowed through for a Beatport API token to work.
      "Access-Control-Allow-Headers": "*",
      // Let the browser read Retry-After so the app can honour the backoff.
      "Access-Control-Expose-Headers": "Retry-After",
    };

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return new Response("Missing ?url=", { status: 400, headers: cors });
    }

    let t;
    try {
      t = new URL(target);
    } catch {
      return new Response("Bad url", { status: 400, headers: cors });
    }
    if (!ALLOWED.has(t.hostname)) {
      return new Response("Forbidden host", { status: 403, headers: cors });
    }

    // Beatport's public search page is server-rendered: ask for HTML and send a
    // browser-like User-Agent, or it won't return the data the app reads.
    const beatport = t.hostname.endsWith("beatport.com");
    const headers = {
      Accept: beatport
        ? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
        : "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      ...(beatport
        ? { Referer: "https://www.beatport.com/" }
        : { Origin: "https://tunebat.com", Referer: "https://tunebat.com/" }),
    };

    // Forward the caller's bearer token (Beatport API) when there is one.
    const auth = request.headers.get("Authorization");
    if (auth) headers.Authorization = auth;

    const upstream = await fetch(t.toString(), { headers });

    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...cors,
        "Content-Type":
          upstream.headers.get("Content-Type") || "application/json",
        // Pass the rate-limit hint through to the app.
        ...(upstream.headers.get("Retry-After")
          ? { "Retry-After": upstream.headers.get("Retry-After") }
          : {}),
      },
    });
  },
};
```

### 3. Get the URL and use it in the app
1. After deploy, copy the worker URL, e.g.
   `https://music-proxy.<your-subdomain>.workers.dev`.
2. In the app **⚙ → CORS proxy for Beatport / tunebat**, paste it with `/?url=`
   appended:
   ```
   https://music-proxy.<your-subdomain>.workers.dev/?url=
   ```
3. Click **⟳ Update collection**.

### 4. Verify it works
Open these in a browser (each should return data, not a CORS/error page):
```
https://music-proxy.<your-subdomain>.workers.dev/?url=https%3A%2F%2Fwww.beatport.com%2Fsearch%2Ftracks%3Fq%3Dgreece%25202000
https://music-proxy.<your-subdomain>.workers.dev/?url=https%3A%2F%2Fapi.tunebat.com%2Fapi%2Ftracks%2Fsearch%3Fterm%3Ddaft%2520punk%2520one%2520more%2520time
```

The Beatport one returns HTML — search it for `__NEXT_DATA__`; that script tag
is what the app reads the tracks out of.

---

## Optional: a Beatport API token

Beatport works **without** a token: the app reads its public search page. A
token switches it to the documented v4 API, which is more stable and returns
cleaner data.

Paste it in **⚙ → Beatport API token**. It is stored only in your browser, and
only ever sent as an `Authorization: Bearer …` header — which means your proxy
must forward that header (the worker above does; most public proxies do not).
If the token is rejected the app says so once and quietly falls back to the
public page, so a stale token never stops a run.

---

## Troubleshooting

- **Keys still empty, console shows CORS error** → the prefix is wrong. It must
  end with `?url=` (nothing after it) so the app can append the encoded URL.
- **403 "Forbidden host"** → the target isn't in the worker's `ALLOWED` set. If
  you copied an older worker that only listed tunebat, add the Beatport hosts.
- **Beatport finds nothing for every track** → open the verification URL above.
  If it returns a page with no `__NEXT_DATA__`, Beatport served a bot/consent
  page instead of results; check the `User-Agent` header is being sent. Setting
  a Beatport token uses the API route instead, which doesn't have this problem.
- **"Beatport rejected the API token"** → either the token expired, or the proxy
  is dropping the `Authorization` header. The app carries on via the public
  page, so this is a warning rather than a failure.
- **429 from either service** → you're being rate-limited; the app paces
  requests (~500 ms between tracks) and backs off when told to. Let it run;
  misses are retried next update.
- **Discogs works but Beatport/tunebat don't** → expected without a proxy;
  Discogs allows CORS, the other two do not.
- **Nothing saves** → tokens/proxy are stored in `localStorage`; make sure the
  browser isn't in a private window that clears storage, and that you didn't
  block storage for the site.

