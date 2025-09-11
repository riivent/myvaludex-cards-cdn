// Node >= 20 (global fetch)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_BASE = "https://api.pokemontcg.io/v2/cards";
const PAGE_SIZE = 250;
const OUT_DIR = join(__dirname, "..", "public", "cards", "name");
const NAMES_FILE = join(__dirname, "..", "data", "names.json");

// Optional: GitHub Secret POKEMONTCG_API_KEY setzen (später in Schritt 4)
const API_HEADERS = process.env.POKEMONTCG_API_KEY
  ? { "X-Api-Key": process.env.POKEMONTCG_API_KEY }
  : {};

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

function buildQuery(raw) {
  const n = raw.trim();

  // Farfetch'd Varianten
  if (/^farfetch/i.test(n)) return `(name:"Farfetch'd" OR name:"Farfetchd")`;

  // Nidoran ♂ / ♀
  if (/nidoran/i.test(n)) {
    const male = /(♂|male|männlich|\(m\)|\bm\b)/i.test(n);
    const female = /(♀|female|weiblich|\(w\)|\bf\b)/i.test(n);
    const nm = `name:"Nidoran♂" OR name:"Nidoran M" OR name:"Nidoran Male"`;
    const nf = `name:"Nidoran♀" OR name:"Nidoran F" OR name:"Nidoran Female"`;
    if (male && !female) return `(${nm})`;
    if (female && !male) return `(${nf})`;
    return `(${nm} OR ${nf})`;
  }

  // Mr. Mime
  if (/^mr\.?\s*mime/i.test(n)) return `name:"Mr. Mime"`;

  // Standard: genauer Name
  return `name:"${n.replace(/"/g, '\\"')}"`;
}

async function fetchAllPages(q) {
  let page = 1;
  let out = [];
  let total = Infinity;

  while (out.length < total) {
    const url = `${API_BASE}?q=${encodeURIComponent(q)}&page=${page}&pageSize=${PAGE_SIZE}&orderBy=set.releaseDate,number`;
    const res = await fetch(url, { headers: { ...API_HEADERS } });
    if (!res.ok) throw new Error(`API ${res.status} for ${q}`);
    const body = await res.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    total = typeof body?.totalCount === "number" ? body.totalCount : out.length + data.length;
    out.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
    if (page > 50) break; // safety
    // kleine Pause, um Limits zu schonen
    await sleep(120);
  }
  return out;
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
  // sicherer Dateiname (URL-encoded)
  return join(OUT_DIR, `${encodeURIComponent(name)}.json`);
}

async function buildOne(name) {
  const q = buildQuery(name);
  const full = await fetchAllPages(q);
  const slim = sortCards(dedupeById(full)).map(slimCard);
  await writeFile(outPathForName(name), JSON.stringify(slim));
  return { name, count: slim.length };
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const names = JSON.parse(await readFile(NAMES_FILE, "utf8"));
  await ensureDir(OUT_DIR);

  const CONCURRENCY = 4; // behutsam/stabil
  let i = 0;
  const results = [];

  async function worker() {
    while (i < names.length) {
      const idx = i++;
      const name = names[idx];
      try {
        const res = await buildOne(name);
        results.push(res);
        console.log(`[${idx + 1}/${names.length}] ${res.name} -> ${res.count}`);
      } catch (e) {
        console.error(`ERROR ${name}:`, e.message);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Index publizieren (Name + Count)
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
