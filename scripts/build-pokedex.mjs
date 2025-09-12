// scripts/build-pokedex.mjs
// Node >= 20 (global fetch). Baut data/pokedex.json mit EN-Namen -> National Dex (1..1025).

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, "..", "data", "pokedex.json");
const MAX_ID = 1025;
const CONCURRENCY = 20;

async function fetchSpecies(id) {
  const url = `https://pokeapi.co/api/v2/pokemon-species/${id}/`;
  const res = await fetch(url, { headers: { "User-Agent": "myvaludex-cards-cdn/1.0" } });
  if (!res.ok) throw new Error(`PokeAPI ${res.status} for id=${id}`);
  return res.json();
}

function englishNameFromSpecies(sp) {
  // PokeAPI gibt 'names' mit allen Sprachen – wir nehmen 'en' (hat die korrekte Schreibweise inkl. Zeichen)
  const en = Array.isArray(sp.names) ? sp.names.find(n => n?.language?.name === "en") : null;
  if (en?.name) return en.name;

  // Fallback (sollte selten greifen): Slug -> "Title Case", rudimentär
  const slug = sp.name || "";
  return slug
    .split("-")
    .map(w => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

async function buildPokedex() {
  await mkdir(dirname(OUT_FILE), { recursive: true });

  const ids = Array.from({ length: MAX_ID }, (_, i) => i + 1);
  const map = {};          // { "Bulbasaur": 1, ... }
  const order = [];        // [{name, id}, ...] für sortierte Ausgabe

  let idx = 0;
  async function worker() {
    while (idx < ids.length) {
      const id = ids[idx++];
      try {
        const sp = await fetchSpecies(id);
        const name = englishNameFromSpecies(sp);
        map[name] = id;
        order.push({ name, id });
        console.log(`[${id}/${MAX_ID}] ${name}`);
      } catch (e) {
        console.error(`ERROR id=${id}:`, e.message);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Nach ID sortieren und als Objekt ausgeben (stabile Reihenfolge)
  order.sort((a, b) => a.id - b.id);
  const sortedObj = {};
  for (const it of order) sortedObj[it.name] = it.id;

  await writeFile(OUT_FILE, JSON.stringify(sortedObj, null, 2), "utf8");
  console.log(`Wrote ${OUT_FILE} (${Object.keys(sortedObj).length} entries)`);
}

buildPokedex().catch(err => {
  console.error(err);
  process.exit(1);
});
