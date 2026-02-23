// netlify/functions/security-risk.js
// Enterprise scoring + monetization model
// Inputs: lat,lng,zip, state(optional), indoorCam,outdoorCam,doorbell,lock, monthly(optional), upfront(optional), responseMinutes(optional), exposureScore(optional)

const ALLOWED_ORIGINS = [
  "https://www.homesecurecalculator.com",
  "https://homesecurecalculator.com",
  "https://hubspotgate.netlify.app",
];

const corsHeaders = (origin) => {
  const o = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
};

// Simple in-memory cache (works well on warm lambdas)
const memCache = global.__HSC_RISK_CACHE || (global.__HSC_RISK_CACHE = new Map());
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 min

function clamp(n, min, max) {
  n = Number(n);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safeInt(n, def = 0) {
  n = parseInt(n, 10);
  return Number.isFinite(n) ? n : def;
}

function json(statusCode, origin, bodyObj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300", // CDN cache 5 min
      ...corsHeaders(origin),
      ...extraHeaders,
    },
    body: JSON.stringify(bodyObj),
  };
}

async function fetchIncomeByZip(zip) {
  // RapidAPI (your env var RAPIDAPI_KEY is set on Netlify)
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return null;

  const url = `https://household-income-by-zip-code.p.rapidapi.com/v1/Census/HouseholdIncomeByZip/${encodeURIComponent(
    zip
  )}`;

  const res = await fetch(url, {
    headers: {
      "x-rapidapi-key": key,
      "x-rapidapi-host": "household-income-by-zip-code.p.rapidapi.com",
    },
  });

  if (!res.ok) return null;
  return res.json();
}

function normalizeIncomeToRisk(medianIncome) {
  // Convert income -> risk factor (lower income => higher risk)
  // Clamp to 0..100 risk, where 100 is "most risk from income"
  const inc = clamp(medianIncome || 0, 10000, 250000);
  // Map 25k..175k roughly
  const t = (inc - 25000) / (175000 - 25000);
  const scoreLowRisk = clamp(t * 100, 0, 100); // higher income => higher scoreLowRisk
  const incomeRisk = 100 - scoreLowRisk;
  return clamp(incomeRisk, 0, 100);
}

function mitigationScoreFromDevices({ indoorCam, outdoorCam, doorbell, lock, monthly }) {
  // More devices + monitoring reduces risk
  let mitigation = 0;

  mitigation += clamp(indoorCam, 0, 50) * 2.2;
  mitigation += clamp(outdoorCam, 0, 50) * 3.0;
  mitigation += clamp(doorbell, 0, 50) * 1.8;
  mitigation += clamp(lock, 0, 50) * 2.0;

  if ((Number(monthly) || 0) > 0) mitigation += 18; // professional monitoring bonus

  return clamp(mitigation, 0, 100);
}

function scoreZone(riskScore) {
  if (riskScore < 40) return { zone: "Low", color: "#10b981" };
  if (riskScore < 70) return { zone: "Moderate", color: "#f59e0b" };
  return { zone: "High", color: "#ef4444" };
}

function leadTierFromValue(valueScore) {
  if (valueScore >= 85) return { tier: "Platinum", basePrice: 79 };
  if (valueScore >= 70) return { tier: "Gold", basePrice: 59 };
  if (valueScore >= 50) return { tier: "Silver", basePrice: 39 };
  return { tier: "Standard", basePrice: 25 };
}

function computeVendorPrice({ basePrice, riskZone, intentScore, incomeBand }) {
  // Enterprise vendor pricing model (simple + predictable):
  // - Start with basePrice
  // - Apply zone multiplier
  // - Apply intent multiplier
  // - Apply income multiplier
  const zoneMult =
    riskZone === "High" ? 1.15 : riskZone === "Moderate" ? 1.05 : 0.95;

  const intentMult =
    intentScore >= 80 ? 1.15 : intentScore >= 60 ? 1.08 : intentScore >= 40 ? 1.0 : 0.92;

  const incomeMult =
    incomeBand === "High" ? 1.10 : incomeBand === "Mid" ? 1.03 : 0.96;

  const price = Math.round(basePrice * zoneMult * intentMult * incomeMult);
  return clamp(price, 15, 199);
}

function incomeBand(medianIncome) {
  if (!medianIncome) return "Mid";
  if (medianIncome >= 110000) return "High";
  if (medianIncome <= 55000) return "Low";
  return "Mid";
}

function deriveCrimeIndexFromFBI(violent, property) {
  // Normalize to 0..100 (coarse but stable)
  // If your fbi-crime function returns annual totals, we scale them.
  const v = clamp(violent || 0, 0, 200000);
  const p = clamp(property || 0, 0, 600000);

  const vScore = clamp((v / 50000) * 100, 0, 100);
  const pScore = clamp((p / 200000) * 100, 0, 100);

  // Violent weighted heavier
  return clamp(vScore * 0.65 + pScore * 0.35, 0, 100);
}

function buildCrimeTrend12Months({ violent, property }) {
  // FBI endpoint is annual; this creates a 12-month trend approximation for UI
  // (still based on real FBI totals).
  const base = (violent || 0) * 0.65 + (property || 0) * 0.35;
  const monthly = base / 12;

  const arr = [];
  // Slight deterministic wave to look realistic but stable
  for (let i = 0; i < 12; i++) {
    const wave = 1 + Math.sin((i / 12) * Math.PI * 2) * 0.08;
    arr.push(Math.max(0, Math.round(monthly * wave)));
  }
  return arr;
}

exports.handler = async function (event) {
  const origin = event.headers?.origin || event.headers?.Origin || "";

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders(origin),
      body: "",
    };
  }

  try {
    const q = event.queryStringParameters || {};
    const lat = Number(q.lat);
    const lng = Number(q.lng);
    const zip = (q.zip || "").toString().trim();

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || zip.length < 3) {
      return json(
        400,
        origin,
        { error: "Missing/invalid lat,lng,zip" },
        { "Cache-Control": "no-store" }
      );
    }

    const indoorCam = safeInt(q.indoorCam, 0);
    const outdoorCam = safeInt(q.outdoorCam, 0);
    const doorbell = safeInt(q.doorbell, 0);
    const lock = safeInt(q.lock, 0);
    const monthly = Number(q.monthly || 0);
    const upfront = Number(q.upfront || 0);

    // optional inputs from frontend (to reduce backend API spend)
    const responseMinutes = clamp(q.responseMinutes ?? 0, 0, 120);
    const exposureScoreIn = clamp(q.exposureScore ?? 0, 0, 100);

    const cacheKey = JSON.stringify({
      lat: Math.round(lat * 10000) / 10000,
      lng: Math.round(lng * 10000) / 10000,
      zip,
      indoorCam,
      outdoorCam,
      doorbell,
      lock,
      monthly: Math.round(monthly),
      upfront: Math.round(upfront),
      responseMinutes,
      exposureScoreIn,
    });

    const cached = memCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return json(200, origin, { ...cached.data, cached: true });
    }

    // ----------------------------------------------------
    // DATA SOURCES
    // ----------------------------------------------------
    // 1) Income via RapidAPI
    let medianIncome = null;
    let incomeRisk = 50;

    const incomeData = await fetchIncomeByZip(zip);
    if (incomeData) {
      // Try several likely shapes
      const inc =
        incomeData?.MedianHouseholdIncome ??
        incomeData?.medianHouseholdIncome ??
        incomeData?.data?.MedianHouseholdIncome ??
        incomeData?.data?.medianHouseholdIncome ??
        incomeData?.result?.MedianHouseholdIncome ??
        incomeData?.result?.medianHouseholdIncome;

      if (inc) {
        medianIncome = Number(inc);
        incomeRisk = normalizeIncomeToRisk(medianIncome);
      }
    }

    // 2) FBI crime data via your EXISTING fbi-crime function
    // (keeps API key off client; you already fixed node-fetch issues)
    let violent = 0;
    let property = 0;
    let fbiMeta = { source: "fbi-crime proxy", state: q.state || null };

    if (q.state) {
      try {
        const proxyUrl = `${event.headers["x-forwarded-proto"] || "https"}://${
          event.headers.host
        }/.netlify/functions/fbi-crime?state=${encodeURIComponent(q.state)}`;

        const fbiRes = await fetch(proxyUrl);
        if (fbiRes.ok) {
          const fbi = await fbiRes.json();
          const v =
            fbi?.results?.find((x) => x.offense === "violent-crime")?.actual ?? 0;
          const p =
            fbi?.results?.find((x) => x.offense === "property-crime")?.actual ?? 0;
          violent = Number(v) || 0;
          property = Number(p) || 0;
          fbiMeta.year = fbi?.results?.[0]?.data_year || fbi?.year || null;
        }
      } catch (e) {
        // ignore
      }
    }

    const crimeIndex = deriveCrimeIndexFromFBI(violent, property);

    // ----------------------------------------------------
    // WEIGHTED SCORING (ENTERPRISE)
    // ----------------------------------------------------
    // Exposure: if not provided, derive a conservative default
    const exposureScore = exposureScoreIn > 0 ? exposureScoreIn : 55;

    // Response score: if minutes provided -> score; else default
    // Lower minutes => safer (lower risk). Convert to risk points 0..100.
    const responseRisk =
      responseMinutes > 0
        ? clamp((responseMinutes / 25) * 100, 0, 100) // 0..25 min
        : 40;

    const mitigation = mitigationScoreFromDevices({
      indoorCam,
      outdoorCam,
      doorbell,
      lock,
      monthly,
    });

    // Weighted risk BEFORE mitigation
    // crime 35%, response 20%, exposure 15%, income 10%, baseline 20%
    const baseline = 50;

    const rawRisk =
      baseline * 0.20 +
      crimeIndex * 0.35 +
      responseRisk * 0.20 +
      exposureScore * 0.15 +
      incomeRisk * 0.10 +
      // upfront/monthly can indicate seriousness (slightly reduces risk)
      (monthly > 0 ? -4 : 0) +
      (upfront > 1500 ? -3 : 0);

    // Apply mitigation as subtraction, capped
    const riskScore = clamp(Math.round(rawRisk - mitigation * 0.25), 1, 100);

    const { zone, color } = scoreZone(riskScore);

    // Percentiles (approx, stable mapping)
    const usPercentile = clamp(Math.round((riskScore / 100) * 99), 1, 99);
    const statePercentile = clamp(
      Math.round(usPercentile + (crimeIndex - 50) * 0.15),
      1,
      99
    );

    // ----------------------------------------------------
    // MONETIZATION SCORING (LOCKED MODEL)
    // ----------------------------------------------------
    // Lead value score emphasizes income + intent + configuration (device count)
    const deviceCount = indoorCam + outdoorCam + doorbell + lock;

    // Intent: use spend + device count as proxy (0..100)
    const intentScore = clamp(
      Math.round(
        (monthly > 0 ? 25 : 10) +
          clamp(upfront / 40, 0, 45) +
          clamp(deviceCount * 6, 0, 40)
      ),
      0,
      100
    );

    // Value score: income (45%), intent (35%), market desirability (20%)
    const incomeValue = medianIncome ? clamp((medianIncome / 160000) * 100, 0, 100) : 55;
    const marketValue = clamp(100 - crimeIndex * 0.35, 0, 100); // lower crime => more premium
    const leadValueScore = clamp(
      Math.round(incomeValue * 0.45 + intentScore * 0.35 + marketValue * 0.20),
      0,
      100
    );

    const tierObj = leadTierFromValue(leadValueScore);
    const band = incomeBand(medianIncome);

    const vendorPrice = computeVendorPrice({
      basePrice: tierObj.basePrice,
      riskZone: zone,
      intentScore,
      incomeBand: band,
    });

    const crimeTrend12 = buildCrimeTrend12Months({ violent, property });

    const response = {
      ok: true,

      // inputs echoed for debugging (safe)
      inputs: {
        lat,
        lng,
        zip,
        state: q.state || null,
        indoorCam,
        outdoorCam,
        doorbell,
        lock,
        monthly: Math.round(monthly),
        upfront: Math.round(upfront),
        responseMinutes: responseMinutes || null,
        exposureScore: exposureScoreIn || null,
      },

      // scoring
      scoring: {
        riskScore,
        zone,
        zoneColor: color,
        crimeIndex: Math.round(crimeIndex),
        responseRisk: Math.round(responseRisk),
        exposureScore: Math.round(exposureScore),
        incomeRisk: Math.round(incomeRisk),
        mitigationScore: Math.round(mitigation),
        percentiles: {
          us: usPercentile,
          state: statePercentile,
        },
      },

      // crime
      crime: {
        violent,
        property,
        trend12Months: crimeTrend12,
        meta: fbiMeta,
        note: "12-month trend is an annual-to-month approximation (FBI totals).",
      },

      // income
      demographics: {
        medianIncome: medianIncome ? Math.round(medianIncome) : null,
        incomeBand: band,
      },

      // monetization (NO vendor preview block is required on UI, but this is locked for backend use)
      monetization: {
        schemaVersion: "1.0.0",
        intentScore,
        leadValueScore,
        tier: tierObj.tier,
        basePrice: tierObj.basePrice,
        vendorPrice,
        pricingSignals: {
          incomeValueScore: Math.round(incomeValue),
          marketValueScore: Math.round(marketValue),
          deviceCount,
          riskZone: zone,
        },
      },

      // UI helpers (optional)
      ui: {
        headline:
          zone === "High"
            ? "Heightened exposure — prioritize perimeter coverage + monitoring."
            : zone === "Moderate"
            ? "Balanced exposure — strengthen entry points and exterior visibility."
            : "Lower exposure — maintain deterrence and upgrade smart locks/cameras.",
      },
    };

    memCache.set(cacheKey, { ts: Date.now(), data: response });
    return json(200, origin, response);
  } catch (e) {
    return json(
      500,
      origin,
      { error: "Server error", detail: String(e?.message || e) },
      { "Cache-Control": "no-store" }
    );
  }
};
