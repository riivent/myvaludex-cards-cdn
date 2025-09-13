// Node >= 20
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ===================== Config ===================== */
const API_BASE = "https://api.pokemontcg.io/v2/cards";
const PAGE_SIZE = 250;
const OUT_DIR = join(__dirname, "..", "public", "cards", "name");
const POKEDEX_FILE = join(__dirname, "..", "data", "pokedex.json");

// Tuning
const CHUNK_CONCURRENCY = 2;      // <-- wie gewünscht
const WRITE_PAUSE_MS = 5;

// Gen-basierte Ranges
const DEX_CHUNKS = [
  [1,151],[152,251],[252,386],[387,493],[494,649],
  [650,721],[722,809],[810,905],[906,1025]
];

// API headers (Key optional, empfohlen)
const API_HEADERS = {
  "Accept": "application/json",
  "User-Agent": "myvaludex-cards-cdn/1.0 (+https://github.com/)",
  ...(process.env.POKEMONTCG_API_KEY ? { "X-Api-Key": process.env.POKEMONTCG_API_KEY } : {})
};

/* ===================== Utils ===================== */
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function isTransientStatus(s){ return s===408 || s===429 || (s>=500&&s<=599) || s===404; }

async function httpJson(url, { maxRetries = 6, baseDelay = 800 } = {}) {
  let lastErr;
  for (let a=0; a<=maxRetries; a++) {
    try {
      const res = await fetch(url, { headers: API_HEADERS });
      if (res.ok) return await res.json();
      if (!isTransientStatus(res.status) || a===maxRetries) throw new Error(`API ${res.status}`);
    } catch (e) { lastErr = e; }
    const delay = baseDelay * Math.pow(2, a) + Math.floor(Math.random()*300);
    await sleep(delay);
  }
  throw lastErr || new Error("HTTP failed");
}

function slimCard(c){
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
function dedupeById(arr){ const s=new Set(); const out=[]; for(const c of arr){ if(!c?.id||s.has(c.id)) continue; s.add(c.id); out.push(c);} return out; }
function sortCards(arr){
  return arr.sort((a,b)=>{
    const da=a?.set?.releaseDate||"0000-00-00", db=b?.set?.releaseDate||"0000-00-00";
    if (da!==db) return da<db?-1:1;
    const na=(a.number||"").toString().padStart(4,"0"), nb=(b.number||"").toString().padStart(4,"0");
    if (na!==nb) return na<nb?-1:1;
    return (a.id||"").localeCompare(b.id||"");
  });
}
async function ensureDir(d){ await mkdir(d, {recursive:true}); }

/* ===================== Fetching ===================== */
async function fetchRangeBasic(start, end){
  const all = [];
  let page=1, guard=0, total=Infinity;
  while (all.length < total) {
    const q = `nationalPokedexNumbers:[${start} TO ${end}]`;
    const url = `${API_BASE}?q=${encodeURIComponent(q)}&page=${page}&pageSize=${PAGE_SIZE}&orderBy=set.releaseDate,number`;
    const body = await httpJson(url, { maxRetries: 6, baseDelay: 900 });
    const data = Array.isArray(body?.data) ? body.data : [];
    total = typeof body?.totalCount === "number" ? body.totalCount : all.length + data.length;
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++; guard++; if (guard > 140) break;
    await sleep(120);
  }
  return all;
}

async function fetchByName(name){
  const q = `name:"${String(name).replace(/"/g,'\\"')}"`;
  const url = `${API_BASE}?q=${encodeURIComponent(q)}&page=1&pageSize=${PAGE_SIZE}&orderBy=set.releaseDate,number`;
  const body = await httpJson(url, { maxRetries: 6, baseDelay: 900 });
  return Array.isArray(body?.data) ? body.data : [];
}

async function fetchRangeAdaptive(start, end, numToName, depth=0){
  try {
    return await fetchRangeBasic(start, end);
  } catch (e) {
    const span = end - start;
    if (span > 10 && depth < 4) {
      const mid = Math.floor((start+end)/2);
      console.warn(`Split range ${start}-${end} -> ${start}-${mid}, ${mid+1}-${end}`);
      const [a,b] = await Promise.all([
        fetchRangeAdaptive(start, mid, numToName, depth+1),
        fetchRangeAdaptive(mid+1, end, numToName, depth+1)
      ]);
      return [...a, ...b];
    }
    // letzter Versuch: Name-Fetch pro Dexnummer (kleine Bereiche)
    console.warn(`Fallback to names for ${start}-${end}`);
    const out = [];
    for (let n=start; n<=end; n++){
      const name = numToName[n];
      if (!name) continue;
      try { out.push(...(await fetchByName(name))); }
      catch (e2){ console.error(`Name fallback failed for ${name}: ${String(e2?.message||e2)}`); }
      await sleep(120);
    }
    return out;
  }
}

/* ===================== Main ===================== */
async function main(){
  const rawDex = await readFile(POKEDEX_FILE, "utf8");
  const dexMap = JSON.parse(rawDex);   // EN-Name -> Nummer
  const numToName = {};                // Nummer -> EN-Name
  for (const [name, num] of Object.entries(dexMap)) numToName[num] = name;

  await ensureDir(OUT_DIR);

  // Sammelbucket: Name -> Karten[]
  const bucket = {};
  for (const name of Object.keys(dexMap)) bucket[name] = [];

  // Chunks mit limitierter Parallelität
  let idx=0;
  async function worker(){
    while (idx < DEX_CHUNKS.length) {
      const myIndex = idx++;
      const [start, end] = DEX_CHUNKS[myIndex];
      console.log(`Fetch range ${start}-${end}`);

      let cards = [];
      try {
        cards = await fetchRangeAdaptive(start, end, numToName, 0);
      } catch (e) {
        console.error(`Range ${start}-${end} failed hard: ${String(e?.message||e)}`);
        cards = [];
      }

      for (const c of cards) {
        const nums = Array.isArray(c.nationalPokedexNumbers) ? c.nationalPokedexNumbers : [];
        for (const dn of nums) {
          const name = numToName[dn];
          if (name) bucket[name].push(c);
        }
      }

      await sleep(400);
    }
  }
  await Promise.all(Array.from({length: CHUNK_CONCURRENCY}, () => worker()));

  // Augment: Karten ohne Dex-Nummer via Namenssuche (Paradox/Sonderfälle)
  const AUGMENT_SET = new Set([
    "Great Tusk","Scream Tail","Brute Bonnet","Flutter Mane","Slither Wing","Sandy Shocks","Roaring Moon",
    "Walking Wake","Raging Bolt","Gouging Fire",
    "Iron Treads","Iron Bundle","Iron Hands","Iron Jugulis","Iron Moth","Iron Thorns","Iron Valiant",
    "Iron Leaves","Iron Crown","Iron Boulder",
    "Mr. Mime","Mr. Rime","Mime Jr.","Farfetch'd","Sirfetch'd","Ho-Oh","Type: Null",
    "Jangmo-o","Hakamo-o","Kommo-o","Porygon-Z"
  ]);
  const namesForAugment = [];
  for (const [name, num] of Object.entries(dexMap)) {
    const have = (bucket[name] || []).length;
    if (AUGMENT_SET.has(name) || (num >= 906 && have < 6)) namesForAugment.push(name);
  }
  console.log(`Augment via name-search for ${namesForAugment.length} species...`);
  const AUG_CONCURRENCY = 3;
  let ai = 0;
  await Promise.all(Array.from({length: AUG_CONCURRENCY}, async () => {
    while (ai < namesForAugment.length) {
      const i = ai++;
      const name = namesForAugment[i];
      try {
        const extra = await fetchByName(name);
        const seen = new Set((bucket[name] || []).map(c => c.id));
        let added = 0;
        for (const c of extra) {
          if (!seen.has(c.id)) { (bucket[name] ||= []).push(c); seen.add(c.id); added++; }
        }
        if (added) console.log(`+ ${name}: +${added} via name`);
      } catch (e) {
        console.warn(`augment failed for ${name}: ${String(e?.message||e)}`);
      }
      await sleep(120);
    }
  }));

  /* ---------- Finaler Pass: garantiert alle 1025 Dateien + Index an 2 Orten ---------- */
  const namesAll = Object.entries(dexMap)
    .sort((a,b) => a[1] - b[1])
    .map(([n]) => n);

  for (const name of namesAll) {
    const raw = bucket[name] || [];
    const slim = sortCards(dedupeById(raw.map(slimCard)));
    await writeFile(join(OUT_DIR, `${encodeURIComponent(name)}.json`), JSON.stringify(slim));
    await sleep(WRITE_PAUSE_MS);
  }

  const finalIndex = namesAll.map(n => ({
    name: n,
    count: (bucket[n] ? dedupeById(bucket[n]).length : 0)
  }));

  // 1) im name/-Ordner (kann in GitHub-UI wegen 1000er-Grenze ausgeblendet werden)
  await writeFile(join(OUT_DIR, "index.json"), JSON.stringify(finalIndex, null, 2));
  // 2) zusätzlich eine Ebene höher – immer gut auffindbar
  await writeFile(join(__dirname, "..", "public", "cards", "index.json"), JSON.stringify(finalIndex, null, 2));

  console.log("DONE:", namesAll.length, "names");
}

main().catch(err => { console.error(err); process.exit(1); });
