// Node >= 20
import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ==== Pfade (Repo: myvaludex-cards-cdn) ====================================
const CARDS_NAME_DIR   = join(__dirname, "..", "public", "cards", "name");
const PRICES_CARD_DIR  = join(__dirname, "..", "public", "prices", "card");
const RETAIN_DAYS      = 400; // ~13 Monate

// Optional PriceCharting (nur wenn konfiguriert)
const PC_API_KEY       = process.env.PRICECHARTING_API_KEY || "";
const PC_ENDPOINT      = process.env.PRICECHARTING_ENDPOINT || ""; // z.B. eigene Proxy-Funktion
const PC_MAP_FILE      = join(__dirname, "..", "data", "pricecharting-map.json"); // { "<cardId>": "<pcProductId>" }

// ==== Helpers ===============================================================
const todayISO = () => new Date().toISOString().slice(0,10);
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (n,a,b)=>Math.min(b,Math.max(a,n));

function dateMinusDays(iso, days){
  const d = new Date(iso+"T00:00:00Z");
  d.setUTCDate(d.getUTCDate()-days);
  return d.toISOString().slice(0,10);
}

async function ensureDir(d){ await mkdir(d, { recursive:true }); }

async function loadJsonSafe(p){
  try { const raw = await readFile(p, "utf8"); return JSON.parse(raw); }
  catch { return null; }
}

function detectVariants(card){
  const s = card?.tcgplayer?.prices || card?.prices || {};
  const set = new Set();
  for (const k of ["normal","holofoil","reverseHolofoil"]) if (s[k]) set.add(k);
  // Cardmarket reverse Trend?
  if (card?.cardmarket?.prices?.reverseHoloTrend != null) set.add("reverseHolofoil");
  if (!set.size) set.add("normal");
  return [...set];
}

function pickTCG(card, variant){
  const root = card?.tcgplayer?.prices
    || (card?.prices && (card.prices.normal || card.prices.holofoil || card.prices.reverseHolofoil) ? card.prices : null)
    || null;
  const v = root?.[variant];
  if (!v) return null;
  return {
    market: isNum(v.market) ? v.market : null,
    low:    isNum(v.low)    ? v.low    : null,
    mid:    isNum(v.mid)    ? v.mid    : null,
    high:   isNum(v.high)   ? v.high   : null,
    directLow: isNum(v.directLow) ? v.directLow : null,
  };
}

function pickCM(card, variant){
  const p = card?.cardmarket?.prices
    || (card?.prices && (card.prices.trendPrice || card.prices.avg7 || card.prices.avg30 || card.prices.lowPrice) ? card.prices : null)
    || null;
  if (!p) return null;

  const base = {
    trend: isNum(p.trendPrice) ? p.trendPrice : null,
    avg7:  isNum(p.avg7)       ? p.avg7       : null,
    avg30: isNum(p.avg30)      ? p.avg30      : null,
    low:   isNum(p.lowPrice)   ? p.lowPrice   : null,
    salesWeek: isNum(p.salesPerWeek) ? p.salesPerWeek
              : isNum(p.weeklySales) ? p.weeklySales : null,
  };
  if (variant === "reverseHolofoil") {
    return {
      ...base,
      trend: isNum(p.reverseHoloTrend) ? p.reverseHoloTrend : base.trend
    };
  }
  return base;
}

async function fetchPricecharting(cardId, mappedId){
  if (!PC_API_KEY || !PC_ENDPOINT || !mappedId) return null;
  // ⚠️ Hier bewusst generisch – dein eigenes Proxy-Endpoint implementiert Auth/Caching.
  try {
    const url = `${PC_ENDPOINT}?k=${encodeURIComponent(PC_API_KEY)}&id=${encodeURIComponent(mappedId)}`;
    const res = await fetch(url, { headers:{ "Accept":"application/json" }});
    if (!res.ok) return null;
    const j = await res.json(); // erwarte { price: number, lastSold?: iso, byFinish?: {normal:{price},holofoil:{...},reverseHolofoil:{...}} }
    return j || null;
  } catch { return null; }
}

function pruneRetention(arr, today=todayISO(), days=RETAIN_DAYS){
  const minDate = dateMinusDays(today, days);
  return arr.filter(r => typeof r?.d === "string" && r.d >= minDate);
}

// ==== Hauptlauf ============================================================
async function main(){
  await ensureDir(PRICES_CARD_DIR);
  const names = (await readdir(CARDS_NAME_DIR)).filter(f => f.endsWith(".json") && f!=="index.json");

  // Optionales PriceCharting Mapping laden
  const pcMap = (await loadJsonSafe(PC_MAP_FILE)) || {};

  const TODAY = todayISO();
  let processed = 0, written = 0;

  // Iterate über alle Name-Dateien und snapshotte Preise der enthaltenen Karten
  for (let i=0;i<names.length;i++){
    const file = names[i];
    const payload = await loadJsonSafe(join(CARDS_NAME_DIR, file));
    const cards = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    if (!cards.length) continue;

    for (const card of cards){
      const id = card?.id;
      if (!id) continue;

      // Ziel-Datei pro Card-ID
      const outPath = join(PRICES_CARD_DIR, `${id}.json`);
      const existing = (await loadJsonSafe(outPath)) || { id, tcgplayer:{}, cardmarket:{}, pricecharting:{} };

      const variants = detectVariants(card);

      // --- TCGplayer je Variante ---
      for (const v of variants){
        const tp = pickTCG(card, v);
        if (!tp) continue;
        const arr = Array.isArray(existing.tcgplayer[v]) ? existing.tcgplayer[v] : [];
        // Duplikat-Schutz
        if (!arr.some(r => r?.d === TODAY)) arr.push({ d: TODAY, ...tp });
        existing.tcgplayer[v] = pruneRetention(arr, TODAY, RETAIN_DAYS);
      }

      // --- Cardmarket je Variante ---
      for (const v of variants){
        const cm = pickCM(card, v);
        if (!cm) continue;
        const arr = Array.isArray(existing.cardmarket[v]) ? existing.cardmarket[v] : [];
        if (!arr.some(r => r?.d === TODAY)) arr.push({ d: TODAY, ...cm });
        existing.cardmarket[v] = pruneRetention(arr, TODAY, RETAIN_DAYS);
      }

      // --- PriceCharting (optional, einmal auf normal, ggf. byFinish) ---
      try {
        const pcId = pcMap[id];
        const pc = await fetchPricecharting(id, pcId);
        if (pc) {
          if (pc.byFinish && typeof pc.byFinish === "object"){
            for (const v of ["normal","holofoil","reverseHolofoil"]){
              const node = pc.byFinish[v];
              if (!node) continue;
              const arr = Array.isArray(existing.pricecharting[v]) ? existing.pricecharting[v] : [];
              if (!arr.some(r => r?.d === TODAY)) arr.push({ d:TODAY, price: isNum(node.price)?node.price:null, lastSold: node.lastSold ?? null });
              existing.pricecharting[v] = pruneRetention(arr, TODAY, RETAIN_DAYS);
            }
          } else {
            const arr = Array.isArray(existing.pricecharting.normal) ? existing.pricecharting.normal : [];
            if (!arr.some(r => r?.d === TODAY)) arr.push({ d:TODAY, price: isNum(pc.price)?pc.price:null, lastSold: pc.lastSold ?? null });
            existing.pricecharting.normal = pruneRetention(arr, TODAY, RETAIN_DAYS);
          }
        }
      } catch {}

      // schreiben
      await ensureDir(PRICES_CARD_DIR);
      await writeFile(outPath, JSON.stringify(existing));
      written++;
      if (written % 150 === 0) await sleep(50);
    }
    processed++;
    if (processed % 25 === 0) console.log(`processed name files: ${processed}/${names.length}`);
  }

  console.log(`DONE prices: files=${processed}, written=${written}`);
}

main().catch(e => { console.error(e); process.exit(1); });
