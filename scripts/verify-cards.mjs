// Node >= 20
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_BASE = "https://api.pokemontcg.io/v2/cards";
const POKEDEX_FILE = join(__dirname, "..", "data", "pokedex.json");
const NAME_DIR = join(__dirname, "..", "public", "cards", "name");

const API_HEADERS = {
  "Accept": "application/json",
  "User-Agent": "myvaludex-cards-verify/1.0 (+https://github.com/)",
  ...(process.env.POKEMONTCG_API_KEY ? { "X-Api-Key": process.env.POKEMONTCG_API_KEY } : {})
};

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function isTransient(s){ return s===408 || s===429 || (s>=500&&s<=599) || s===404; }

async function apiTotalCount(q, {maxRetries=5, baseDelay=600}={}) {
  let lastErr;
  for (let a=0; a<=maxRetries; a++){
    try{
      const url = `${API_BASE}?q=${encodeURIComponent(q)}&pageSize=1`;
      const res = await fetch(url, { headers: API_HEADERS });
      if (res.ok) {
        const body = await res.json();
        return typeof body?.totalCount === "number" ? body.totalCount : 0;
      }
      if (!isTransient(res.status) || a===maxRetries) throw new Error(`API ${res.status}`);
    }catch(e){ lastErr=e; }
    await sleep(baseDelay * Math.pow(2,a) + Math.floor(Math.random()*250));
  }
  throw lastErr || new Error("verify failed");
}

async function main(){
  const dexMap = JSON.parse(await readFile(POKEDEX_FILE, "utf8"));
  const list = Object.entries(dexMap).sort((a,b)=>a[1]-b[1]).map(([name,num])=>({name,num}));

  // gespeicherte Counts lesen
  const saved = new Map();
  for (const {name} of list) {
    try {
      const file = join(NAME_DIR, `${encodeURIComponent(name)}.json`);
      const arr = JSON.parse(await readFile(file, "utf8"));
      saved.set(name, Array.isArray(arr) ? arr.length : 0);
    } catch {
      saved.set(name, 0);
    }
  }

  // Kandidaten: problematische/neuere Spezies zuerst prüfen (schont Rate-Limit)
  const AUGMENT_SET = new Set([
    "Great Tusk","Scream Tail","Brute Bonnet","Flutter Mane","Slither Wing","Sandy Shocks","Roaring Moon",
    "Walking Wake","Raging Bolt","Gouging Fire",
    "Iron Treads","Iron Bundle","Iron Hands","Iron Jugulis","Iron Moth","Iron Thorns","Iron Valiant",
    "Iron Leaves","Iron Crown","Iron Boulder",
    "Mr. Mime","Mr. Rime","Mime Jr.","Farfetch'd","Sirfetch'd","Ho-Oh","Type: Null",
    "Jangmo-o","Hakamo-o","Kommo-o","Porygon-Z"
  ]);

  const candidates = list.filter(({name,num}) => {
    const c = saved.get(name) || 0;
    return c === 0 || c < 3 || num >= 906 || AUGMENT_SET.has(name);
  });

  // Begrenzen (du kannst den Wert erhöhen, falls Rate-Limit ok ist)
  const MAX_CHECK = 300;
  const toCheck = candidates.slice(0, MAX_CHECK);

  console.log(`Verify: checking ${toCheck.length}/${list.length} species (focus on low counts & Paldea/Paradox).`);

  const diffs = [];
  const CONC = 5;
  let i = 0;
  async function worker(){
    while (i < toCheck.length){
      const idx = i++;
      const {name, num} = toCheck[idx];
      const savedCount = saved.get(name) || 0;

      try {
        const dexQ = `nationalPokedexNumbers:${num}`;
        const nameQ = `name:"${name.replace(/"/g,'\\"')}"`;
        const [dexCount, nameCount] = await Promise.all([
          apiTotalCount(dexQ),
          apiTotalCount(nameQ)
        ]);
        const expected = Math.max(dexCount, nameCount);
        const gap = expected - savedCount;
        if (gap > 0) {
          diffs.push({ name, num, saved: savedCount, expected, gap });
          console.log(`MISSING ${name} (#${num}): saved=${savedCount}, expected=${expected}, gap=${gap}`);
        }
      } catch (e) {
        console.warn(`VERIFY FAIL ${name}: ${String(e?.message||e)}`);
      }
      await sleep(100);
    }
  }
  await Promise.all(Array.from({length: CONC}, () => worker()));

  // Report speichern
  const report = {
    checked: toCheck.length,
    totalSpecies: list.length,
    missing: diffs.length,
    items: diffs.sort((a,b)=>b.gap - a.gap)
  };
  await writeFile(join(__dirname, "..", "public", "cards", "_verify.json"), JSON.stringify(report, null, 2));
  console.log(`\nVERIFY DONE: ${report.missing} species with gaps. Report: public/cards/_verify.json`);

  // Kurze Zusammenfassung (für GITHUB_STEP_SUMMARY)
  const summary = [
    `## Verify vs API`,
    ``,
    `- Checked species: **${report.checked}** / ${report.totalSpecies}`,
    `- Species with gaps: **${report.missing}**`,
    ``,
    `Top 10 gaps:`,
    ...report.items.slice(0,10).map(it => `- ${it.name} (#${it.num}): saved=${it.saved}, expected=${it.expected}, gap=${it.gap}`)
  ].join("\n");
  try { await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" }); } catch {}
}

main().catch(e => { console.error(e); process.exit(1); });
