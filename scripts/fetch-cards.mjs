// Node >= 20
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_BASE = "https://api.pokemontcg.io/v2/cards";
const PAGE_SIZE = 250;
const OUT_DIR = join(__dirname, "..", "public", "cards", "name");
const POKEDEX_FILE = join(__dirname, "..", "data", "pokedex.json");

// HEADERS (API-Key optional, aber empfohlen)
const API_HEADERS = {
  "Accept": "application/json",
  "User-Agent": "myvaludex-cards-cdn/1.0 (+https://github.com/)",
  ...(process.env.POKEMONTCG_API_KEY ? { "X-Api-Key": process.env.POKEMONTCG_API_KEY } : {})
};

// Dex-Chunks (Gen-basiert, überschaubare Result-Mengen pro Query)
const DEX_CHUNKS = [
  [1, 151],   // Kanto
  [152, 251], // Johto
  [252, 386], // Hoenn
  [387, 493], // Sinnoh
  [494, 649], // Unova
  [650, 721], // Kalos
  [722, 809], // Alola
  [810, 905], // Galar/Hisui
  [906, 1025] // Paldea
];

/* ---------------- Hilfen ---------------- */

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function isTransientStatus(s) {
  // 429/408/5xx sind transient; 404 kommt bei Last manchmal fälschlich -> auch retry
  return s === 408 || s === 429 || (s >= 500 && s <= 599) || s === 404;
}

async function httpJson(url, { maxRetries = 6, baseDelay = 700 } = {}) {
  let lastErr;
  for (let a = 0; a <= maxRetries; a++) {
    try {
      const res = await fetch(url, { headers: API_HEADERS });
      if (res.ok) return await res.json();
      if (!isTransientStatus(res.status) || a === maxRetries) {
        throw new Error(`API ${res.status}`);
      }
      const delay = baseDelay * Math.pow(2, a) + Math.floor(Math.random() * 250);
      await sleep(delay);
      continue;
    } catch (e) {
      lastErr = e;
      const delay = baseDelay * Math.pow(2, a) + Math.floor(Math.random() * 250);
      await sleep(delay);
    }
  }
  throw lastErr || new Error("HTTP failed");
}

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

/* ---------------- Bulk-Fetch nach Dex-Range ---------------- */

async function fetchRange(start, end) {
  const all = [];
  let page = 1;
  let guard = 0;
  let total = Infinity;

  while (all.length < total) {
    const q = `nationalPokedexNumbers:[${start} TO ${end}]`;
    const url = `${API_BASE}?q=${encodeURIComponent(q)}&page=${page}&pageSize=${PAGE_SIZE}&orderBy=set.releaseDate,number`;
    const body = await httpJson(url, { maxRetries: 6, baseDelay: 800 });
    const data = Array.isArray(body?.data) ? body.data : [];
    total = typeof body?.totalCount === "number" ? body.totalCount : all.length + data.length;
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
    guard++;
    if (guard > 120) break; // Safety
    await sleep(150);       // sanft scrollen
  }

  return all;
}

/* ---------------- Main ---------------- */

async function main() {
  // Dex Map laden (EN-Name -> Nummer) und reverse Map bauen (Nummer -> EN-Name)
  const rawDex = await readFile(POKEDEX_FILE, "utf8");
  const dexMap = JSON.parse(rawDex);
  const numToName = {};
  for (const [name, num] of Object.entries(dexMap)) numToName[num] = name;

  await ensureDir(OUT_DIR);

  // Ergebnissammler: Name -> Karten[]
  const result = {};
  for (const name of Object.keys(dexMap)) result[name] = [];

  // Alle Chunks nacheinander holen und einsortieren
  for (const [start, end] of DEX_CHUNKS) {
    console.log(`Fetch range ${start}-${end}`);
    const cards = await fetchRange(start, end);

    for (const c of cards) {
      const dexList = Array.isArray(c.nationalPokedexNumbers) ? c.nationalPokedexNumbers : [];
      if (!dexList.length) continue;
      for (const dn of dexList) {
        const name = numToName[dn];
        if (!name) continue; // unbekannt/außerhalb 1..1025
        result[name].push(c);
      }
    }
    // kleine Pause zwischen Chunks
    await sleep(500);
  }

  // Alle Namen schreiben (immer eine Datei, auch wenn leer)
  const namesSorted = Object.entries(dexMap).sort((a,b) => a[1] - b[1]).map(([n]) => n);

  for (const name of namesSorted) {
    const slim = sortCards(dedupeById(result[name].map(slimCard)));
    const path = join(OUT_DIR, `${encodeURIComponent(name)}.json`);
    await writeFile(path, JSON.stringify(slim));
    console.log(`${name} -> ${slim.length}`);
    // mini-Pause, damit wir nicht als „write flood“ wirken
    await sleep(10);
  }

  // Index mit Zählung
  const index = namesSorted.map(n => ({ name: n, count: result[n] ? dedupeById(result[n]).length : 0 }));
  await writeFile(join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2));
  console.log("DONE:", namesSorted.length, "names");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
