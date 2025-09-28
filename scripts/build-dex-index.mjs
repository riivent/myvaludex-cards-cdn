// scripts/build-dex-index.mjs
import fs from "fs";
import path from "path";

const root = path.resolve(process.cwd());

// Findet dynamisch den richtigen "cards"-Ordner
function resolveCardsBase() {
  const candidates = [
    path.join(root, "public", "cards"),
    path.join(root, "cards"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "name"))) return c;
  }
  // Falls keiner existiert, aber "public" existiert: public/cards verwenden
  const publicCards = path.join(root, "public", "cards");
  if (fs.existsSync(path.join(root, "public"))) return publicCards;
  // Fallback: root/cards
  return path.join(root, "cards");
}

const CARDS_BASE = resolveCardsBase();
const NAME_DIR   = path.join(CARDS_BASE, "name");
const DEX_DIR    = path.join(CARDS_BASE, "dex");

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function toArray(p) { if (Array.isArray(p)) return p; if (Array.isArray(p?.data)) return p.data; if (Array.isArray(p?.cards)) return p.cards; return []; }
function readJsonSafe(fp) { try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return null; } }
function getDexIds(card) {
  const out = new Set();
  const push = (arr) => Array.isArray(arr) && arr.forEach(v => { const n = parseInt(String(v), 10); if (!Number.isNaN(n)) out.add(n); });
  push(card?.nationalPokedexNumbers);
  push(card?._raw?.nationalPokedexNumbers);
  push(card?.pokedexNumbers);
  push(card?._raw?.pokedexNumbers);
  if (typeof card?.dexId === "number") out.add(card.dexId);
  if (typeof card?.dex   === "number") out.add(card.dex);
  return [...out];
}

function writeDexFiles(mapDexToCards) {
  ensureDir(DEX_DIR);
  for (const [dex, arr] of mapDexToCards.entries()) {
    // unique by id
    const uniq = Array.from(new Map(arr.map(c => [c.id, c])).values());
    // newest sets first, dann Karten-Nr.
    uniq.sort((a,b) => {
      const ad = Date.parse(a?.set?.releaseDate || a?._raw?.set?.releaseDate || a?.releaseDate || "1970-01-01");
      const bd = Date.parse(b?.set?.releaseDate || b?._raw?.set?.releaseDate || b?.releaseDate || "1970-01-01");
      if (bd !== ad) return bd - ad;
      return String(b.number||"").localeCompare(String(a.number||""));
    });

    const json = JSON.stringify(uniq);
    const d  = String(dex);
    const d3 = d.padStart(3,"0");
    const d4 = d.padStart(4,"0");
    fs.writeFileSync(path.join(DEX_DIR, `${d4}.json`), json); // kanonisch
    fs.writeFileSync(path.join(DEX_DIR, `${d3}.json`), json); // kompat
    fs.writeFileSync(path.join(DEX_DIR, `${d}.json`),  json); // kompat
  }
}

function main() {
  console.log("Cards base:", CARDS_BASE);
  console.log("Name dir  :", NAME_DIR);
  console.log("Dex dir   :", DEX_DIR);

  if (!fs.existsSync(NAME_DIR)) {
    console.error("ERROR: Not found:", NAME_DIR);
    process.exit(1);
  }

  const entries = fs.readdirSync(NAME_DIR).filter(f => f.endsWith(".json"));
  const dexMap = new Map();

  for (const file of entries) {
    const payload = readJsonSafe(path.join(NAME_DIR, file));
    const cards = toArray(payload);
    for (const c of cards) {
      const ids = getDexIds(c);
      for (const id of ids) {
        if (!dexMap.has(id)) dexMap.set(id, []);
        dexMap.get(id).push(c);
      }
    }
  }

  writeDexFiles(dexMap);
  console.log("Dex index built:", dexMap.size, "dex buckets");
}

main();
