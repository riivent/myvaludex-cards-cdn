// scripts/build-dex-jsons.mjs
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const namesDir = path.join(root, "public", "cards", "name");
const dexDir   = path.join(root, "public", "cards", "dex");
const mapPath  = path.join(root, "data", "dex-map.json");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJSON(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function countCards(payload) {
  // Name-JSON ist typischerweise ein Array von Karten.
  // Falls es mal ein Objekt mit {data:[...]} ist, fangen wir das ab.
  if (Array.isArray(payload)) return payload.length;
  if (payload && Array.isArray(payload.data)) return payload.data.length;
  return 0;
}

if (!fs.existsSync(namesDir)) {
  console.error("❌ public/cards/name/ nicht gefunden – erst die Names bauen lassen!");
  process.exit(1);
}
if (!fs.existsSync(mapPath)) {
  console.error("❌ data/dex-map.json nicht gefunden.");
  process.exit(1);
}

const dexMap = readJSON(mapPath);              // { "0029": "Nidoran♀", ... }
ensureDir(dexDir);

const index = [];
const missing = [];

for (const [dex, name] of Object.entries(dexMap)) {
  const src = path.join(namesDir, `${name}.json`);
  const dst = path.join(dexDir, `${dex}.json`);

  if (!fs.existsSync(src)) {
    missing.push({ dex, name, reason: "name-json not found" });
    continue;
  }
  const payload = readJSON(src);
  writeJSON(dst, payload);

  index.push({
    dex,
    name,
    count: countCards(payload)
  });
}

// kleine Index-/Verify-Dateien schreiben
// => /public/cards/dex/index.json  (Zum schnellen Check im Browser/Worker)
writeJSON(path.join(dexDir, "index.json"), index.sort((a,b)=>a.dex.localeCompare(b.dex)));
// => /public/cards/dex/_verify.json  (Fehlende Quellen sichtbar machen)
writeJSON(path.join(dexDir, "_verify.json"), { missing });

console.log(`✅ dex gebaut: ${index.length} Dateien`);
if (missing.length) {
  console.log(`⚠️  Fehlende Quellen: ${missing.length} (siehe public/cards/dex/_verify.json)`);
}
