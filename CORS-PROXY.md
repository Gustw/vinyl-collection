# Adding a CORS proxy for tunebat

The app fetches keys/BPM from `https://api.tunebat.com` directly in your browser.
tunebat does **not** send CORS headers, so the browser blocks the response and
keys/BPM stay empty. (Discogs data still loads fine — it allows CORS.)

To fix this you point the app at a **CORS proxy**: a tiny service that fetches
tunebat server-side and re-serves the response *with* CORS headers.

## How the app uses the value

The app builds each request as:

```
<CORS proxy prefix> + encodeURIComponent("https://api.tunebat.com/api/tracks/search?term=...")
```

So the value you paste **must end where a URL-encoded URL should be appended** —
in practice it ends with `?url=` (or similar).

Where to paste it: click the **⚙ (settings)** button in the app → field
**"CORS proxy for tunebat (prefix)"**. It's saved in your browser only
(localStorage).

---

## Option A — Quick test with a public proxy (not reliable long-term)

1. Open the app and click **⚙**.
2. In **CORS proxy for tunebat**, paste:
   ```
   https://api.allorigins.win/raw?url=
   ```
3. Close settings and click **⟳ Update collection**. Keys/BPM should start
   filling in.

> Public proxies are rate-limited, slow, and can disappear without notice. Use
> them only to confirm the flow works, then switch to your own (Option B).

---

## Option B — Your own Cloudflare Worker (recommended, free)

This gives you a fast, private, reliable proxy on a free Cloudflare account.

### 1. Create the Worker
1. Sign in at <https://dash.cloudflare.com> (create a free account if needed).
2. Left sidebar → **Workers & Pages** → **Create** → **Create Worker**.
3. Give it a name (e.g. `tunebat-proxy`) → **Deploy** (a hello-world worker is
   created).
4. Click **Edit code**.

### 2. Paste this code
Replace the default code with the following, then **Deploy**:

```js
export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      // Let the browser read Retry-After so the app can honour tunebat's backoff.
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

    // Only allow proxying tunebat, so this can't be abused as an open proxy.
    let t;
    try {
      t = new URL(target);
    } catch {
      return new Response("Bad url", { status: 400, headers: cors });
    }
    if (t.hostname !== "api.tunebat.com" && t.hostname !== "tunebat.com") {
      return new Response("Forbidden host", { status: 403, headers: cors });
    }

    // Fetch tunebat server-side with browser-like headers it expects.
    const upstream = await fetch(t.toString(), {
      headers: {
        Accept: "application/json",
        Origin: "https://tunebat.com",
        Referer: "https://tunebat.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });

    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...cors,
        "Content-Type":
          upstream.headers.get("Content-Type") || "application/json",
        // Pass tunebat's rate-limit hint through to the app.
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
   `https://tunebat-proxy.<your-subdomain>.workers.dev`.
2. In the app **⚙ → CORS proxy for tunebat**, paste it with `/?url=` appended:
   ```
   https://tunebat-proxy.<your-subdomain>.workers.dev/?url=
   ```
3. Click **⟳ Update collection**.

### 4. Verify it works
Open this in a browser (should return JSON, not a CORS/error page):
```
https://tunebat-proxy.<your-subdomain>.workers.dev/?url=https%3A%2F%2Fapi.tunebat.com%2Fapi%2Ftracks%2Fsearch%3Fterm%3Ddaft%2520punk%2520one%2520more%2520time
```

---

## Troubleshooting

- **Keys still empty, console shows CORS error** → the prefix is wrong. It must
  end with `?url=` (nothing after it) so the app can append the encoded URL.
- **403 "Forbidden host"** → you changed the target; the worker only proxies
  `api.tunebat.com` by design. Remove the check if you want it more permissive.
- **429 from tunebat** → you're being rate-limited; the app already paces
  requests (~300 ms between tracks). Let it run; misses are retried next update.
- **Discogs works but tunebat doesn't** → expected without a proxy; Discogs
  allows CORS, tunebat does not.
- **Nothing saves** → tokens/proxy are stored in `localStorage`; make sure the
  browser isn't in a private window that clears storage, and that you didn't
  block storage for the site.

