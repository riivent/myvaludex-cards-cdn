// src/worker.js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const BASE = (env.ASSET_BASE || "https://riivent.github.io/myvaludex-cards-cdn").replace(/\/$/, "");

    // CORS / preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const send = (data, status = 200, extra = {}) =>
      new Response(typeof data === "string" ? data : JSON.stringify(data), {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=300, s-maxage=3600",
          ...corsHeaders(),
          ...extra,
        },
      });

    try {
      const parts = url.pathname.replace(/^\/+/, "").split("/"); // e.g. cards/name/Pikachu.json

      if (parts[0] !== "cards") {
        return send({ error: "Use /cards/name/<Name>.json or /cards/dex/<Dex>.json" }, 404);
      }

      // /cards/dex/:dex.json  (dex darf 1 oder 0001 sein)
      if (parts[1] === "dex") {
        const raw = (parts[2] || "").replace(/\.json$/i, "");
        if (!raw) return send({ error: "Missing dex" }, 400);

        const digits = raw.replace(/\D/g, "");
        const pad = digits.padStart(4, "0");
        const target = `${BASE}/cards/dex/${pad}.json`;

        const r = await fetch(target, { cf: { cacheEverything: true, cacheTtl: 3600 } });
        if (!r.ok) return send({ error: "dex not found", upstream: target, status: r.status }, r.status);

        const resp = new Response(r.body, r);
        resp.headers.set("access-control-allow-origin", "*");
        resp.headers.set("cache-control", "public, max-age=300, s-maxage=3600");
        return resp;
      }

      // /cards/name/:name.json
      if (parts[1] === "name") {
        const raw = (parts[2] || "").replace(/\.json$/i, "");
        if (!raw) return send({ error: "Missing name" }, 400);

        const tried = [];
        for (const variant of nameVariants(decodeURIComponent(raw))) {
          const target = `${BASE}/cards/name/${encodeURIComponent(variant)}.json`;
          tried.push(target);
          const r = await fetch(target, { cf: { cacheEverything: true, cacheTtl: 3600 } });
          if (r.ok) {
            const resp = new Response(r.body, r);
            resp.headers.set("access-control-allow-origin", "*");
            resp.headers.set("cache-control", "public, max-age=300, s-maxage=3600");
            return resp;
          }
        }
        return send({ error: "name not found", tried }, 404);
      }

      return send({ error: "Bad route" }, 404);
    } catch (err) {
      return send({ error: "Worker exception", message: String(err) }, 500);
    }
  },
};

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,HEAD,OPTIONS",
    "access-control-allow-headers": "Content-Type",
  };
}

function nameVariants(input) {
  // Robust gegen Apostrophe/Diakritik/Schreibweise
  const s = input.trim();
  const set = new Set();

  set.add(s); // as-is
  set.add(s.replace(/’/g, "'")); // curly -> straight
  set.add(s.replace(/'/g, "’")); // straight -> curly
  set.add(s.replace(/é/g, "e")); // fallback für é
  set.add(s.replace(/\b\w/g, (c) => c.toUpperCase())); // Title Case
  set.add(s.replace(/\s+JR\.?$/i, " Jr.")); // Mime Jr. usw.

  return [...set];
}
