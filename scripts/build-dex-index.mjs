// scripts/build-dex-index.mjs
import fs from "fs";
import path from "path";

const root = path.resolve(process.cwd());
const NAME_DIR = path.join(root, "public", "cards", "name");
const DEX_DIR  = path.join(root, "public", "cards", "dex");

function toArray(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.cards)) return payload.cards;
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
  if (typeof card?.dex   === "number") out.add(card.dex);
  return [...out];
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function writeDexFiles(mapDexToCards) {
  ensureDir(DEX_DIR);
  for (const [dex, arr] of mapDexToCards.entries()) {
    // unique by id + sort by set.releaseDate desc
    const uniq = Array.from(new Map(arr.map(c => [c.id, c])).values());
    uniq.sort((a,b) => {
      const ad = Date.parse(a?.set?.releaseDate||a?._raw?.set?.releaseDate||a?.releaseDate||"1970-01-01");
      const bd = Date.parse(b?.set?.releaseDate||b?._raw?.set?.releaseDate||b?.releaseDate||"1970-01-01");
      if (bd !== ad) return bd - ad;
      return String(b.number||"").localeCompare(String(a.number||""));
    });

    const json = JSON.stringify(uniq);
    const d    = String(dex);
    const d3   = d.padStart(3, "0");
    const d4   = d.padStart(4, "0");

    // 4-stellig (kanonisch)
    fs.writeFileSync(path.join(DEX_DIR, `${d4}.json`), json);
    // 3-stellig + unpadded als Backups/Kompat
    fs.writeFileSync(path.join(DEX_DIR, `${d3}.json`), json);
    fs.writeFileSync(path.join(DEX_DIR, `${d}.json`),  json);
  }
}

function main() {
  if (!fs.existsSync(NAME_DIR)) {
    console.error("Missing directory:", NAME_DIR);
    process.exit(1);
  }
  const entries = fs.readdirSync(NAME_DIR).filter(f => f.endsWith(".json"));

  const dexMap = new Map(); // dex:number -> cards[]
  for (const file of entries) {
    const full = path.join(NAME_DIR, file);
    const payload = readJsonSafe(full);
    const cards = toArray(payload);
    for (const c of cards) {
      const ids = getDexIds(c);
      // Falls Karte keine Dex trägt (selten), skip – wir wollen nur verlässliche Zuordnung
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
