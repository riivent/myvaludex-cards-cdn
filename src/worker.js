export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const ORIGIN = "https://riivent.github.io/myvaludex-cards-cdn";

    // Health
    if (url.pathname === "/" || url.pathname === "/_health") {
      return new Response("ok", { headers: { "cache-control": "no-store" } });
    }

    // -------- DEX: allow 0001 or 1 --------
    // /cards/dex/<id>.json  where <id> may be "0001" or "1"
    if (/^\/cards\/dex\/[^/]+\.json$/i.test(url.pathname)) {
      const m = url.pathname.match(/^\/cards\/dex\/([^/]+)\.json$/i);
      const raw = m?.[1] ?? "";
      const n = Number.parseInt(raw, 10);   // "0001" -> 1
      if (!Number.isFinite(n)) {
        return json({ error: "bad dex id" }, 400);
      }
      const target = `${ORIGIN}/cards/dex/${n}.json`; // unpadded on the origin
      return proxyJSON(target);
    }

    // -------- NAME passthrough (funktioniert bei dir bereits) --------
    // keep normalization minimal – deine Namen-JSONs sind schon im CDN
    if (/^\/cards\/name\/.+\.json$/i.test(url.pathname)) {
      const name = decodeURIComponent(url.pathname.replace(/^\/cards\/name\/|\.json$/g, ""));
      const target = `${ORIGIN}/cards/name/${encodeURIComponent(name)}.json`;
      return proxyJSON(target);
    }

    // Fallback: alles andere direkt weiterreichen
    const fallback = `${ORIGIN}${url.pathname}${url.search}`;
    return fetch(fallback, { cf: { cacheEverything: true } });
  }
};

async function proxyJSON(target) {
  const res = await fetch(target, { cf: { cacheEverything: true } });
  if (!res.ok) {
    return json({ error: `${res.status} ${res.statusText}`, upstream: target }, res.status);
  }
  const h = new Headers(res.headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("access-control-allow-origin", "*");
  h.set("cache-control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=60");
  return new Response(res.body, { status: res.status, headers: h });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    }
  });
}
