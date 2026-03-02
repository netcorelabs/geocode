// netlify/functions/hubspot-sync.js
// Create/update HubSpot contact + safely apply only properties that exist.
//
// ENV REQUIRED:
//   HUBSPOT_PRIVATE_APP_TOKEN
//
// Expects POST body:
//   { payload: {...}, risk: {...} }

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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
};

function json(statusCode, origin, bodyObj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
      ...extraHeaders,
    },
    body: JSON.stringify(bodyObj),
  };
}

function toStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function toNumStr(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return String(Math.round(n));
}

function cleanEmpty(props) {
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    const s = String(v);
    if (s.trim() === "") continue;
    out[k] = s;
  }
  return out;
}

// Cached HubSpot contact property names (warm lambda)
const memCache =
  global.__HSC_HS_PROPS_CACHE || (global.__HSC_HS_PROPS_CACHE = { ts: 0, set: null });

const CACHE_TTL_MS = 1000 * 60 * 30;

async function hsFetch(path, method, token, body) {
  const url = `https://api.hubapi.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  return { ok: res.ok, status: res.status, data };
}

async function getContactPropertyNameSet(token) {
  const now = Date.now();
  if (memCache.set && (now - memCache.ts) < CACHE_TTL_MS) return memCache.set;

  // Pull all contact properties so we can filter unknown ones
  const r = await hsFetch(`/crm/v3/properties/contacts?archived=false`, "GET", token);
  if (!r.ok || !Array.isArray(r.data?.results)) {
    // Fail open: no filtering (but better than breaking)
    const fallback = new Set();
    memCache.ts = now;
    memCache.set = fallback;
    return fallback;
  }

  const set = new Set(r.data.results.map(p => p.name));
  memCache.ts = now;
  memCache.set = set;
  return set;
}

function filterToExistingProps(props, existingSet) {
  // If set is empty (fallback), do not filter
  if (!existingSet || existingSet.size === 0) {
    return { filtered: props, skippedUnknown: [] };
  }
  const filtered = {};
  const skippedUnknown = [];
  for (const [k, v] of Object.entries(props)) {
    if (existingSet.has(k)) filtered[k] = v;
    else skippedUnknown.push(k);
  }
  return { filtered, skippedUnknown };
}

// Fallback parser if client didn't send segregated parts.
// "5203 Legendary Ln, Acworth, GA 30102, USA"
function splitFormattedAddress(formatted) {
  const s = String(formatted || "").trim();
  const out = { address: "", city: "", state: "", zip: "", country: "" };
  if (!s) return out;

  const parts = s.split(",").map(x => x.trim()).filter(Boolean);
  // best-effort:
  // [0]=street, [1]=city, [2]=state zip, [3]=country
  out.address = parts[0] || "";
  out.city = parts[1] || "";
  if (parts[2]) {
    const m = parts[2].match(/^([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/);
    if (m) { out.state = m[1].toUpperCase(); out.zip = m[2]; }
    else out.state = parts[2].slice(0, 2).toUpperCase();
  }
  out.country = parts[3] || parts[parts.length - 1] || "";
  return out;
}

exports.handler = async function (event) {
  const origin = event.headers?.origin || event.headers?.Origin || "";

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return json(405, origin, { ok: false, error: "Method not allowed" });
  }

  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) {
    return json(500, origin, { ok: false, error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }, { "Cache-Control": "no-store" });
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const payload = body.payload || {};
  const risk = body.risk || {};

  const email = toStr(payload.email).trim();
  if (!email) {
    return json(400, origin, { ok: false, error: "Missing email" }, { "Cache-Control": "no-store" });
  }

  // --- Address: use segregated fields if present, otherwise parse formatted ---
  const formatted = toStr(payload.hsc_property_address || payload.address || payload.geo?.formatted || "").trim();
  const parsed = splitFormattedAddress(formatted);

  const street = toStr(payload.street_address || payload["Street Address"] || parsed.address).trim();
  const city = toStr(payload.city || payload["City"] || parsed.city).trim();
  const state = toStr(payload.state_code || payload["State/Region Code"] || payload.state || parsed.state).trim();
  const zip = toStr(payload.postal_code || payload["postal code"] || payload.zip || parsed.zip).trim();
  const country = toStr(payload.country_region || payload["Country/Region"] || payload.country || parsed.country).trim();

  // --- Build HubSpot properties (INTERNAL NAMES) ---
  // Standard internal names:
  // firstname, lastname, email, phone, address, city, state, zip, country
  const props = cleanEmpty({
    firstname: toStr(payload.firstname),
    lastname: toStr(payload.lastname),
    email,
    phone: toStr(payload.phone),

    // ✅ Correct HubSpot address internals:
    address: street,
    city: city,
    state: state,
    zip: zip,
    country: country,

    // ✅ Your custom fields (only applied if they exist in your portal)
    hsc_property_address: formatted || `${street}, ${city}, ${state} ${zip}, ${country}`.trim(),
    hsc_devices: toStr(payload.hsc_devices || payload.deviceSummary || payload.selectedItems),
    hsc_monthly: toNumStr(payload.hsc_monthly ?? payload.monthly),
    hsc_upfront: toNumStr(payload.hsc_upfront ?? payload.upfront),
    hsc_risk_score: toNumStr(payload.hsc_risk_score ?? risk?.scoring?.riskScore),
    hsc_system_tier: toStr(payload.hsc_system_tier || payload.systemTier || payload.tier),

    installation_type: toStr(payload.installation_type || payload.installMode || payload.install),
    service_plan: toStr(payload.service_plan || payload.monitorPlan || payload.monitoring),

    smart_locks: toNumStr(payload.smart_locks ?? payload.lock),

    utm_source: toStr(payload.utm_source),
    utm_campaign: toStr(payload.utm_campaign),
    utm_term: toStr(payload.utm_term),
    utm_content: toStr(payload.utm_content),
  });

  // Filter props to only those that exist in HubSpot (prevents 400 errors)
  const existing = await getContactPropertyNameSet(token);
  const { filtered, skippedUnknown } = filterToExistingProps(props, existing);

  // Search contact by email
  const search = await hsFetch(`/crm/v3/objects/contacts/search`, "POST", token, {
    filterGroups: [
      { filters: [{ propertyName: "email", operator: "EQ", value: email }] }
    ],
    properties: ["email"],
    limit: 1
  });

  let action = "updated";
  let contactId = null;

  if (search.ok && Array.isArray(search.data?.results) && search.data.results.length) {
    contactId = search.data.results[0].id;
    const patch = await hsFetch(`/crm/v3/objects/contacts/${contactId}`, "PATCH", token, {
      properties: filtered
    });
    if (!patch.ok) {
      return json(patch.status, origin, {
        ok: false,
        error: "HubSpot update failed",
        detail: patch.data,
        attempted: Object.keys(filtered),
        skippedUnknown
      }, { "Cache-Control": "no-store" });
    }
  } else {
    action = "created";
    const create = await hsFetch(`/crm/v3/objects/contacts`, "POST", token, {
      properties: filtered
    });
    if (!create.ok) {
      return json(create.status, origin, {
        ok: false,
        error: "HubSpot create failed",
        detail: create.data,
        attempted: Object.keys(filtered),
        skippedUnknown
      }, { "Cache-Control": "no-store" });
    }
    contactId = create.data?.id || null;
  }

  return json(200, origin, {
    ok: true,
    action,
    contactId,
    applied: Object.keys(filtered),
    skippedUnknown
  });
};
