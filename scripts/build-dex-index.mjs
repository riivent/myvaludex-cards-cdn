// scripts/build-dex-index.mjs
import fs from "fs";
import path from "path";

const root = process.cwd();
const PUB_NAME = path.join(root, "public", "cards", "name");
const ALT_NAME = path.join(root, "cards", "name");

// Quelle wählen (public bevorzugt)
const NAME_DIR = fs.existsSync(PUB_NAME) ? PUB_NAME : (fs.existsSync(ALT_NAME) ? ALT_NAME : null);
if (!NAME_DIR) {
  console.error("ERROR: Kein Name-Ordner gefunden (public/cards/name ODER cards/name).");
  process.exit(1);
}

// Ziele: in BEIDE Orte schreiben (spiegeln)
const PUB_DEX = path.join(root, "public", "cards", "dex");
const ALT_DEX = path.join(root, "cards", "dex");
const TARGETS = [PUB_DEX, ALT_DEX];

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function toArray(p) {
  if (!p) return [];
  if (Array.isArray(p)) return p;
  if (Array.isArray(p?.data)) return p.data;
  if (Array.isArray(p?.cards)) return p.cards;
  return [];
}
function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, "utf8")); }
  catch { return null; }
}
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
  if (typeof card?.dex === "number") out.add(card.dex);
  return [...out];
}

function writeDexFiles(mapDexToCards) {
  // beide Zielordner anlegen
  TARGETS.forEach(ensureDir);

  for (const [dex, arr] of mapDexToCards.entries()) {
    // unique by id
    const uniq = Array.from(new Map(arr.map(c => [c.id, c])).values());
    // sort: newest sets first, dann Kartennummer
    uniq.sort((a, b) => {
      const ad = Date.parse(a?.set?.releaseDate || a?._raw?.set?.releaseDate || a?.releaseDate || "1970-01-01");
      const bd = Date.parse(b?.set?.releaseDate || b?._raw?.set?.releaseDate || b?.releaseDate || "1970-01-01");
      if (bd !== ad) return bd - ad;
      return String(b.number || "").localeCompare(String(a.number || ""));
    });

    const payload = JSON.stringify(uniq);
    const d  = String(dex);
    const d3 = d.padStart(3, "0");
    const d4 = d.padStart(4, "0");

    for (const dir of TARGETS) {
      fs.writeFileSync(path.join(dir, `${d4}.json`), payload);
      fs.writeFileSync(path.join(dir, `${d3}.json`), payload);
      fs.writeFileSync(path.join(dir, `${d}.json`),  payload);
    }
  }
}

function main() {
  console.log("NAME_DIR:", NAME_DIR);
  console.log("PUB_DEX :", PUB_DEX);
  console.log("ALT_DEX :", ALT_DEX);

  const files = fs.readdirSync(NAME_DIR).filter(f => f.endsWith(".json"));
  if (!files.length) {
    console.error("ERROR: Keine Name-JSONs gefunden in:", NAME_DIR);
    process.exit(1);
  }

  const dexMap = new Map();
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

  writeDexFiles(dexMap);
  console.log("Dex index built:", dexMap.size, "dex buckets");
}

main();
