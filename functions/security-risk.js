// netlify/functions/security-risk.js
// Enterprise weighted scoring + income + monetization
// Env:
// - RAPIDAPI_KEY (required for income scoring)
// - FBI_API_KEY (optional for FBI CDE summarized endpoints)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

const memCache = {
  incomeByZip: new Map(),   // zip -> { ts, val }
  crimeByState: new Map(),  // state -> { ts, val }
};

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function now(){ return Date.now(); }

function cacheGet(map, key, ttlMs){
  const hit = map.get(key);
  if(!hit) return null;
  if(now() - hit.ts > ttlMs) { map.delete(key); return null; }
  return hit.val;
}
function cacheSet(map, key, val){
  map.set(key, { ts: now(), val });
  return val;
}

function toNum(x, def=0){
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

function safeJsonParse(str){
  try{ return JSON.parse(str); }catch(_){ return null; }
}

// Deep extract a plausible "median income" from unknown RapidAPI payloads
function extractMedianIncome(obj){
  if(!obj || typeof obj !== "object") return null;

  // Common likely keys
  const candidates = [
    "MedianHouseholdIncome",
    "medianHouseholdIncome",
    "Median_Income",
    "median_income",
    "medianIncome",
    "median_household_income",
    "MedianIncome",
  ];

  for(const k of candidates){
    const v = obj[k];
    if(Number.isFinite(Number(v)) && Number(v) > 1000) return Number(v);
  }

  // Search recursively for fields containing both "median" and "income"
  const stack = [obj];
  while(stack.length){
    const cur = stack.pop();
    if(!cur || typeof cur !== "object") continue;

    for(const [k, v] of Object.entries(cur)){
      if(v && typeof v === "object") stack.push(v);
      const key = String(k).toLowerCase();
      if(key.includes("median") && key.includes("income")){
        const n = Number(v);
        if(Number.isFinite(n) && n > 1000) return n;
      }
    }
  }

  return null;
}

async function fetchIncomeByZip(zip){
  const ttl = 1000 * 60 * 60 * 24 * 7; // 7 days
  const cached = cacheGet(memCache.incomeByZip, zip, ttl);
  if(cached) return { ...cached, cacheHit: true };

  const key = process.env.RAPIDAPI_KEY;
  if(!key) return { medianIncome: null, source: "none", cacheHit: false };

  const url = `https://household-income-by-zip-code.p.rapidapi.com/v1/Census/HouseholdIncomeByZip/${encodeURIComponent(zip)}`;

  const t0 = now();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-rapidapi-key": key,
      "x-rapidapi-host": "household-income-by-zip-code.p.rapidapi.com",
    }
  });

  if(!res.ok){
    const out = { medianIncome: null, source: "rapidapi", cacheHit: false, ms: now()-t0 };
    cacheSet(memCache.incomeByZip, zip, out);
    return out;
  }

  const json = await res.json();
  const median = extractMedianIncome(json);

  const out = { medianIncome: median || null, source: "rapidapi", cacheHit: false, ms: now()-t0 };
  cacheSet(memCache.incomeByZip, zip, out);
  return out;
}

// FBI CDE summarized endpoint (optional). Falls back if unavailable.
async function fetchCrimeByState(state){
  const ttl = 1000 * 60 * 60 * 24 * 3; // 3 days
  const cached = cacheGet(memCache.crimeByState, state, ttl);
  if(cached) return { ...cached, cacheHit: true };

  const apiKey = process.env.FBI_API_KEY || "";
  const endYear = new Date().getFullYear() - 1;
  const startYear = endYear - 4;

  // NOTE: Endpoint path may differ depending on your FBI API variant.
  // This implementation is defensive: if it fails, we return fallback.
  const base = "https://api.usa.gov/crime/fbi/cde/crime-data/api/summarized/state";
  const violentUrl = `${base}/${encodeURIComponent(state)}/violent-crime/${startYear}/${endYear}${apiKey ? `?API_KEY=${encodeURIComponent(apiKey)}` : ""}`;
  const propertyUrl = `${base}/${encodeURIComponent(state)}/property-crime/${startYear}/${endYear}${apiKey ? `?API_KEY=${encodeURIComponent(apiKey)}` : ""}`;

  const t0 = now();
  try{
    const [vRes, pRes] = await Promise.all([fetch(violentUrl), fetch(propertyUrl)]);

    if(!vRes.ok || !pRes.ok) throw new Error("FBI endpoint not ok");

    const vJson = await vRes.json();
    const pJson = await pRes.json();

    // Typical structure: { results: [{ actual, population, ... }, ...] }
    const vRows = Array.isArray(vJson?.results) ? vJson.results : [];
    const pRows = Array.isArray(pJson?.results) ? pJson.results : [];

    const sum = (rows) => rows.reduce((acc, r) => acc + (Number(r.actual)||0), 0);
    const pop = (rows) => rows.reduce((acc, r) => Math.max(acc, Number(r.population)||0), 0);

    const vActual = sum(vRows);
    const pActual = sum(pRows);
    const vPop = pop(vRows);
    const pPop = pop(pRows);

    const vRate = (vPop > 0) ? (vActual / vPop) * 100000 : null;
    const pRate = (pPop > 0) ? (pActual / pPop) * 100000 : null;

    const out = {
      violent: { actual: vActual, ratePer100k: vRate },
      property:{ actual: pActual, ratePer100k: pRate },
      source: "fbi",
      cacheHit: false,
      ms: now()-t0
    };

    cacheSet(memCache.crimeByState, state, out);
    return out;

  }catch(_){
    const out = {
      violent: { actual: 0, ratePer100k: null },
      property:{ actual: 0, ratePer100k: null },
      source: "fallback",
      cacheHit: false,
      ms: now()-t0
    };
    cacheSet(memCache.crimeByState, state, out);
    return out;
  }
}

function scaleCrimeIndex(violentRatePer100k, propertyRatePer100k){
  // Conservative normalization ranges (tunable)
  // Violent: 0–900, Property: 0–6000
  const v = violentRatePer100k == null ? 0 : clamp((violentRatePer100k / 900) * 100, 0, 100);
  const p = propertyRatePer100k == null ? 0 : clamp((propertyRatePer100k / 6000) * 100, 0, 100);
  // Weighted into a single index (violent heavier)
  return clamp(v * 0.60 + p * 0.40, 0, 100);
}

function computeIncomeScores(medianIncome){
  // Normalize income: 35k–160k
  if(!medianIncome) return { affluenceScore: 50, incomeRisk: 50 };
  const aff = clamp(((medianIncome - 35000) / (160000 - 35000)) * 100, 0, 100);
  // incomeRisk: lower income → higher risk
  const incRisk = clamp(100 - aff, 0, 100);
  return { affluenceScore: Math.round(aff), incomeRisk: Math.round(incRisk) };
}

function computeMitigationScore(dev){
  const indoor = toNum(dev.indoorCam);
  const outdoor = toNum(dev.outdoorCam);
  const doorbell = toNum(dev.doorbell);
  const lock = toNum(dev.lock);

  // Tunable: outdoor cams + locks mitigate more
  const raw =
    indoor * 2.0 +
    outdoor * 3.2 +
    doorbell * 1.5 +
    lock * 2.8;

  return clamp(Math.round(raw), 0, 35);
}

function computeExposureScore(dev){
  // Exposure increases when coverage is low
  const indoor = toNum(dev.indoorCam);
  const outdoor = toNum(dev.outdoorCam);
  const doorbell = toNum(dev.doorbell);
  const lock = toNum(dev.lock);

  const coverage = clamp(indoor*2 + outdoor*3 + doorbell*2 + lock*2, 0, 40);
  const exposure = clamp(100 - Math.round((coverage/40)*60) - 20, 0, 100); // baseline
  return exposure;
}

function computeIntentScore(spend, dev){
  const upfront = toNum(spend.upfront);
  const monthly = toNum(spend.monthly);

  const deviceSignal =
    toNum(dev.indoorCam)*4 +
    toNum(dev.outdoorCam)*6 +
    toNum(dev.doorbell)*3 +
    toNum(dev.lock)*5;

  // Spend normalization
  const upfrontScore = clamp((upfront / 3000) * 100, 0, 100);
  const monthlyScore = clamp((monthly / 80) * 100, 0, 100);

  const intent = clamp(
    upfrontScore * 0.45 +
    monthlyScore * 0.35 +
    clamp(deviceSignal, 0, 100) * 0.20,
    0, 100
  );

  return Math.round(intent);
}

function tierFromScore(score){
  if(score >= 85) return "Platinum";
  if(score >= 70) return "Gold";
  if(score >= 55) return "Silver";
  return "Bronze";
}

function priceFromTier(tier){
  // Tunable base prices
  switch(tier){
    case "Platinum": return 95;
    case "Gold": return 65;
    case "Silver": return 45;
    default: return 25;
  }
}

function zoneFromRisk(riskScore){
  if(riskScore < 35) return { zone:"Low", zoneColor:"#10b981" };
  if(riskScore < 70) return { zone:"Moderate", zoneColor:"#f59e0b" };
  return { zone:"High", zoneColor:"#ef4444" };
}

function approxTrend12Months(total){
  // deterministic pseudo-trend (stable per total)
  const base = Math.max(1, Math.round((total || 120) / 12));
  const wobble = [0,1,-1,2,1,0,-1,1,0,2,-1,0];
  return wobble.map((w,i)=> Math.max(0, base + w));
}

exports.handler = async (event) => {
  if(event.httpMethod === "OPTIONS"){
    return { statusCode: 204, headers: CORS, body: "" };
  }

  try{
    const q = event.queryStringParameters || {};
    const lat = toNum(q.lat, NaN);
    const lng = toNum(q.lng, NaN);
    const zip = String(q.zip || "").trim();
    const state = String(q.state || "").trim().toUpperCase();

    if(!Number.isFinite(lat) || !Number.isFinite(lng)){
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok:false, error:"Missing/invalid lat,lng" }) };
    }

    // Devices + spend
    const devices = {
      indoorCam: toNum(q.indoorCam),
      outdoorCam: toNum(q.outdoorCam),
      doorbell: toNum(q.doorbell),
      lock: toNum(q.lock),
    };
    const spend = {
      upfront: toNum(q.upfront),
      monthly: toNum(q.monthly),
    };

    const tStart = now();

    // Income + crime fetch (parallel)
    const [income, crime] = await Promise.all([
      zip ? fetchIncomeByZip(zip) : Promise.resolve({ medianIncome:null, source:"none", cacheHit:false, ms:0 }),
      state ? fetchCrimeByState(state) : Promise.resolve({ violent:{actual:0,ratePer100k:null}, property:{actual:0,ratePer100k:null}, source:"none", cacheHit:false, ms:0 })
    ]);

    // Scoring components
    const crimeIndex = scaleCrimeIndex(crime.violent.ratePer100k, crime.property.ratePer100k);
    const { affluenceScore, incomeRisk } = computeIncomeScores(income.medianIncome);

    const mitigationScore = computeMitigationScore(devices);
    const exposureScore = computeExposureScore(devices);

    // Response risk (enterprise placeholder: you can replace with a real model later)
    // Slightly higher in higher-crime + lower-affluence areas
    const responseRisk = clamp(Math.round(crimeIndex * 0.55 + incomeRisk * 0.25 + exposureScore * 0.20), 0, 100);

    // FINAL RISK (weighted)
    const riskRaw =
      (crimeIndex * 0.55) +
      (responseRisk * 0.15) +
      (exposureScore * 0.20) +
      (incomeRisk * 0.10) -
      (mitigationScore * 0.35);

    const riskScore = clamp(Math.round(riskRaw), 0, 100);
    const zoneObj = zoneFromRisk(riskScore);

    // Percentiles (approx mapping; replace with real distribution later)
    const usPct = clamp(Math.round(riskScore), 1, 99);
    const stPct = clamp(Math.round(riskScore * 0.95 + 5), 1, 99);

    // Monetization
    const intentScore = computeIntentScore(spend, devices);
    const urgencyScore = riskScore;

    // Lead quality: affluence + intent + urgency
    const qualityScore = clamp(Math.round(
      affluenceScore * 0.40 +
      intentScore * 0.40 +
      urgencyScore * 0.20
    ), 0, 100);

    const tier = tierFromScore(qualityScore);
    let priceUsd = priceFromTier(tier);

    // Small state-based adjustment (optional tuning)
    const highDemandStates = new Set(["CA","TX","FL","NY","NJ","IL","GA","NC","AZ","WA"]);
    if(highDemandStates.has(state)) priceUsd = Math.round(priceUsd * 1.10);

    const totalMs = now() - tStart;

    const out = {
      ok: true,
      version: "enterprise-1.0.0",
      inputs: {
        lat, lng, zip, state,
        devices,
        spend
      },
      crime: {
        violent: crime.violent,
        property: crime.property,
        trend12Months: approxTrend12Months((crime.violent.actual||0) + (crime.property.actual||0)),
        source: crime.source
      },
      demographics: {
        medianIncome: income.medianIncome,
        source: income.source
      },
      scoring: {
        riskScore,
        zone: zoneObj.zone,
        zoneColor: zoneObj.zoneColor,
        crimeIndex: Math.round(crimeIndex),
        responseRisk,
        exposureScore,
        mitigationScore,
        percentiles: { us: usPct, state: stPct }
      },
      monetization: {
        schemaVersion: "1.0.0",
        qualityScore,
        tier,
        priceUsd,
        components: {
          affluenceScore,
          intentScore,
          urgencyScore
        },
        model: {
          weights: { affluence: 0.40, intent: 0.40, urgency: 0.20 },
          tierThresholds: { Platinum: 85, Gold: 70, Silver: 55 },
          basePrices: { Platinum: 95, Gold: 65, Silver: 45, Bronze: 25 }
        }
      },
      ui: {
        headline:
          `Classified as ${zoneObj.zone} risk based on crime index, ZIP income, exposure, and mitigation from your configuration.`,
      },
      cache: {
        incomeHit: !!income.cacheHit,
        crimeHit: !!crime.cacheHit
      },
      timingsMs: {
        income: income.ms || 0,
        crime: crime.ms || 0,
        total: totalMs
      }
    };

    return { statusCode: 200, headers: { ...CORS, "Content-Type":"application/json" }, body: JSON.stringify(out) };

  }catch(e){
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok:false, error: e.message || "Server error" }) };
  }
};
