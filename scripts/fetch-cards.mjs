// Node >= 20 (global fetch)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_BASE = "https://api.pokemontcg.io/v2/cards";
const PAGE_SIZE = 250;
const OUT_DIR = join(__dirname, "..", "public", "cards", "name");
const NAMES_FILE = join(__dirname, "..", "data", "names.json");
const POKEDEX_FILE = join(__dirname, "..", "data", "pokedex.json");

// API-Key (optional, empfohlen)
const API_HEADERS = {
  "Accept": "application/json",
  "User-Agent": "myvaludex-cards-cdn/1.0 (+https://github.com/)",
  ...(process.env.POKEMONTCG_API_KEY ? { "X-Api-Key": process.env.POKEMONTCG_API_KEY } : {})
};

let POKEDEX_MAP = {}; // Name -> Dex

/* ---------------- Slimming ---------------- */
function slimCard(c) {
  return {
    id: c.id,
    name: c.name,
    images: c.images ? { small: c.images.small, large: c.images.large } : undefined,
    set: c.set ? { name: c.set.name, series: c.set.series, releaseDate: c.set.releaseDate } : undefined,
    number: c.number,
    rarity: c.rarity,
    subtypes: c.subtypes,
    tcgplayer: c.tcgplayer ? { prices: c.tcgplayer.prices } : undefined,
    cardmarket: c.cardmarket ? { prices: c.cardmarket.prices } : undefined
  };
}

/* ---------------- Query-Building ---------------- */
function dexForName(name) {
  if (!name) return null;
  if (POKEDEX_MAP[name] != null) return POKEDEX_MAP[name];
  const key = Object.keys(POKEDEX_MAP).find(k => k.toLowerCase() === String(name).toLowerCase());
  return key ? POKEDEX_MAP[key] : null;
}

function specialNameQuery(n) {
  if (/^farfetch/i.test(n)) return `(name:"Farfetch'd" OR name:"Farfetchd")`;
  if (/nidoran/i.test(n)) {
    const male = /(♂|male|männlich|\(m\)|\bm\b)/i.test(n);
    const female = /(♀|female|weiblich|\(w\)|\bf\b)/i.test(n);
    const nm = `name:"Nidoran♂" OR name:"Nidoran M" OR name:"Nidoran Male"`;
    const nf = `name:"Nidoran♀" OR name:"Nidoran F" OR name:"Nidoran Female"`;
    if (male && !female) return `(${nm})`;
    if (female && !male) return `(${nf})`;
    return `(${nm} OR ${nf})`;
  }
  if (/^mr\.?\s*mime/i.test(n)) return `name:"Mr. Mime"`;
  return null;
}

function buildPrimaryQuery(nameRaw) {
  const n = (nameRaw || "").trim();
  const dex = dexForName(n);
  if (dex != null) return { type: "dex", q: `nationalPokedexNumbers:${dex}` };
  const special = specialNameQuery(n);
  if (special) return { type: "name-special", q: special };
  return { type: "name", q: `name:"${String(n).replace(/"/g, '\\"')}"` };
}

function buildFallbackQuery(nameRaw) {
  const n = (nameRaw || "").trim();
  // Fallback: wenn Dex/Spezial versagt, probiere generische Namensphrase
  return `name:"${String(n).replace(/"/g, '\\"')}"`;
}

/* ---------------- HTTP mit Retries ---------------- */
function isTransientStatus(s) {
  // 429/408/5xx sind klar transient; die API liefert in Einzelfällen 404 bei Last -> mitretry behandeln
  return s === 408 || s === 429 || (s >= 500 && s <= 599) || s === 404;
}

async function httpJson(url, { maxRetries = 5, baseDelay = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { headers: API_HEADERS });
      if (res.ok) {
        return await res.json();
      }
      if (!isTransientStatus(res.status) || attempt === maxRetries) {
        throw new Error(`API ${res.status}`);
      }
      const delay = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      await sleep(delay);
      continue;
    } catch (e) {
      lastErr = e;
      const delay = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      await sleep(delay);
    }
  }
  throw lastErr || new Error("HTTP failed");
}

/* ---------------- Fetching ---------------- */
async function fetchAllPagesWithQuery(q) {
  let page = 1;
  let out = [];
  let total = Infinity;
  let pageGuard = 0;

  while (out.length < total) {
    const url = `${API_BASE}?q=${encodeURIComponent(q)}&page=${page}&pageSize=${PAGE_SIZE}&orderBy=set.releaseDate,number`;
    const body = await httpJson(url, { maxRetries: 5, baseDelay: 600 });
    const data = Array.isArray(body?.data) ? body.data : [];
    total = typeof body?.totalCount === "number" ? body.totalCount : out.length + data.length;
    out.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
    pageGuard++;
    if (pageGuard > 40) break; // Safety
    await sleep(120);
  }
  return out;
}

async function fetchAllPagesSmart(name) {
  const { type, q } = buildPrimaryQuery(name);
  try {
    return await fetchAllPagesWithQuery(q);
  } catch (e) {
    // Fallback bei hartnäckigen Fehlern
    if (type !== "name") {
      const fb = buildFallbackQuery(name);
      try {
        return await fetchAllPagesWithQuery(fb);
      } catch (e2) {
        throw e2;
      }
    }
    throw e;
  }
}

function dedupeById(arr) {
  const seen = new Set();
  const out = [];
  for (const c of arr) {
    if (!c?.id || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

function sortCards(arr) {
  return arr.sort((a, b) => {
    const da = a?.set?.releaseDate || "0000-00-00";
    const db = b?.set?.releaseDate || "0000-00-00";
    if (da !== db) return da < db ? -1 : 1;
    const na = (a.number || "").toString().padStart(4, "0");
    const nb = (b.number || "").toString().padStart(4, "0");
    if (na !== nb) return na < nb ? -1 : 1;
    return (a.id || "").localeCompare(b.id || "");
  });
}

async function ensureDir(d) {
  await mkdir(d, { recursive: true });
}

function outPathForName(name) {
  return join(OUT_DIR, `${encodeURIComponent(name)}.json`);
}

async function buildOne(name) {
  try {
    const full = await fetchAllPagesSmart(name);
    const slim = sortCards(dedupeById(full)).map(slimCard);
    await writeFile(outPathForName(name), JSON.stringify(slim));
    return { name, count: slim.length, ok: true };
  } catch (e) {
    console.error(`ERROR ${name}: ${String(e?.message || e)}`);
    // Trotzdem eine (leere) Datei schreiben, damit nichts fehlt
    await writeFile(outPathForName(name), "[]");
    return { name, count: 0, ok: false };
  }
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

/* ---------------- Main ---------------- */
async function main() {
  // Dex laden (Name -> Nummer). Wenn nicht vorhanden: fallback auf names.json
  try {
    const rawDex = await readFile(POKEDEX_FILE, "utf8");
    POKEDEX_MAP = JSON.parse(rawDex || "{}");
  } catch {
    POKEDEX_MAP = {};
  }

  let names = [];
  if (Object.keys(POKEDEX_MAP).length) {
    names = Object.entries(POKEDEX_MAP).sort((a,b) => a[1] - b[1]).map(([n]) => n);
  } else {
    const raw = await readFile(NAMES_FILE, "utf8");
    names = JSON.parse(raw);
  }

  await ensureDir(OUT_DIR);

  // Weniger Parallelität → weniger Rate-Limit/Timeouts
  const CONCURRENCY = 2;
  let i = 0;
  const results = [];

  async function worker() {
    while (i < names.length) {
      const idx = i++;
      const name = names[idx];
      const res = await buildOne(name);
      results.push(res);
      console.log(`[${idx + 1}/${names.length}] ${name} -> ${res.count}`);
      // kleine Pause zwischen Namen
      await sleep(120);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await writeFile(
    join(__dirname, "..", "public", "cards", "name", "index.json"),
    JSON.stringify(results, null, 2)
  );

  console.log("DONE:", results.length, "names");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
