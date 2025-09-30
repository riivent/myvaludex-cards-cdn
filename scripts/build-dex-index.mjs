// scripts/build-dex-index.mjs
// Baut DEX-JSONs primär aus bestehenden name/*.json,
// und füllt fehlende DEX via PokémonTCG API (nationalPokedexNumbers:<dex>).

import fs from "fs";
import path from "path";

const root = process.cwd();
const PUB_NAME = path.join(root, "public", "cards", "name");
const ALT_NAME = path.join(root, "cards", "name");
const NAME_DIR = fs.existsSync(PUB_NAME) ? PUB_NAME : (fs.existsSync(ALT_NAME) ? ALT_NAME : null);

// Ziele: in BEIDE Orte schreiben (Repo sichtbar + kompatibel)
const PUB_DEX = path.join(root, "public", "cards", "dex");
const ALT_DEX = path.join(root, "cards", "dex");
const TARGETS = [PUB_DEX, ALT_DEX];

const API = "https://api.pokemontcg.io/v2/cards";
const API_KEY = process.env.POKEMONTCG_API_KEY || "";

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function toArray(p) {
  if (!p) return [];
  if (Array.isArray(p)) return p;
  if (Array.isArray(p?.data)) return p.data;
  if (Array.isArray(p?.cards)) return p.cards;
  return [];
}
function readJsonSafe(fp) { try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return null; } }
function getDexIds(card) {
  const out = new Set();
  const push = (arr) => Array.isArray(arr) && arr.forEach(v => {
    const n = parseInt(String(v), 10);
    if (!Number.isNaN(n)) out.add(n);
  });
  push(card?.nationalPokedexNumbers);
  push(card?._raw?.nationalPokedexNumbers);
  push(card?.pokedexNumbers);
  push(card?._raw?.pokedexNumbers);
  if (typeof card?.dexId === "number") out.add(card.dexId);
  if (typeof card?.dex   === "number") out.add(card.dex);
  return [...out];
}
function uniqById(arr) { return Array.from(new Map(arr.map(c => [c.id, c])).values()); }
function sortCards(arr) {
  return arr.sort((a,b) => {
    const ad = Date.parse(a?.set?.releaseDate || a?._raw?.set?.releaseDate || a?.releaseDate || "1970-01-01");
    const bd = Date.parse(b?.set?.releaseDate || b?._raw?.set?.releaseDate || b?.releaseDate || "1970-01-01");
    if (bd !== ad) return bd - ad;
    return String(b.number||"").localeCompare(String(a.number||""));
  });
}
function writeDexPayload(dex, cards) {
  const payload = JSON.stringify(cards);
  const d  = String(dex);
  const d3 = d.padStart(3,"0");
  const d4 = d.padStart(4,"0");
  for (const dir of TARGETS) {
    ensureDir(dir);
    // Schreibe unpadded und 3-/4-stellig → deckt alle Clients + Worker ab
    fs.writeFileSync(path.join(dir, `${d}.json`),  payload);
    fs.writeFileSync(path.join(dir, `${d3}.json`), payload);
    fs.writeFileSync(path.join(dir, `${d4}.json`), payload);
  }
}
async function fetchAllFromAPI(url) {
  const headers = API_KEY ? { "X-Api-Key": API_KEY } : {};
  const out = [];
  let page = 1;
  while (true) {
    const u = `${url}&page=${page}&pageSize=250`;
    const res = await fetch(u, { headers });
    if (!res.ok) break;
    const j = await res.json();
    const data = toArray(j);
    if (!data.length) break;
    out.push(...data);
    if (data.length < 250) break; // fertig
    page++;
    if (page > 20) break; // safety
  }
  return out;
}
async function fetchDexFromAPI(dex) {
  // API: nationalPokedexNumbers:<dex>
  const q = encodeURIComponent(`nationalPokedexNumbers:${dex}`);
  const url = `${API}?q=${q}`;
  return await fetchAllFromAPI(url);
}

// spezielle DEX-IDs, die oft fehlen (aus deinem Report)
const SPECIAL_MISSING = new Set([29,32,83,122,439,669,772,785,786,787,788,865,866,
  984,985,986,987,988,989,990,991,992,993,994,995,1005,1006,1009,1010,1020,1021,1022,1023]);

async function main() {
  console.log("NAME_DIR:", NAME_DIR ?? "(none)");
  console.log("PUB_DEX :", PUB_DEX);
  console.log("ALT_DEX :", ALT_DEX);

  const dexMap = new Map(); // dex:number -> cards[]

  // 1) Vorbefüllen aus vorhandenen name/*.json
  if (NAME_DIR) {
    const files = fs.readdirSync(NAME_DIR).filter(f => f.endsWith(".json"));
    for (const file of files) {
      const data = readJsonSafe(path.join(NAME_DIR, file));
      const cards = toArray(data);
      for (const c of cards) {
        for (const id of getDexIds(c)) {
          if (!dexMap.has(id)) dexMap.set(id, []);
          dexMap.get(id).push(c);
        }
      }
    }
    console.log("Prefilled from names for", dexMap.size, "dex buckets");
  } else {
    console.warn("No name directory found; will fetch all specials from API.");
  }

  // 2) Fehlende DEX aus API nachladen (nur die Spezialfälle bzw. die, die wir nicht haben)
  const missingDex = Array.from(SPECIAL_MISSING).filter(d => !dexMap.has(d));
  if (missingDex.length) {
    if (!API_KEY) {
      console.warn("POKEMONTCG_API_KEY fehlt – kann fehlende DEX nicht aus API füllen:", missingDex.join(", "));
    } else {
      console.log("Fetching missing dex from API:", missingDex.join(", "));
      for (const d of missingDex) {
        const apiCards = await fetchDexFromAPI(d);
        if (apiCards.length) {
          dexMap.set(d, apiCards);
        } else {
          console.warn("No API cards for dex", d);
        }
      }
    }
  }

  // 3) Schreiben
  let written = 0;
  for (const [dex, arr] of dexMap.entries()) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const uniq = uniqById(arr);
    writeDexPayload(dex, sortCards(uniq));
    written++;
  }
  console.log("Dex index built:", written, "dex buckets written");
}

main().catch(e => {
  console.error("DEX build failed:", e);
  process.exit(1);
});
