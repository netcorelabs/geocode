// netlify/functions/hubspot-sync.js
export async function handler(event) {
const allowedOrigins = [
"https://www.homesecurecalculator.com",
"https://homesecurecalculator.com",
"http://www.homesecurecalculator.com",
    "http://homesecurecalculator.com",
"https://www.netcoreleads.com",
"https://netcoreleads.com",
"https://api.netcoreleads.com",
"https://hubspotgate.netlify.app",
];

function corsHeaders(originRaw) {
const origin = (originRaw || "").trim();
const allowOrigin = origin ? (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]) : "*";
return {
"Access-Control-Allow-Origin": allowOrigin,
"Access-Control-Allow-Headers": "Content-Type, Authorization",
"Access-Control-Allow-Methods": "POST, OPTIONS",
"Vary": "Origin",
"Cache-Control": "no-store",
"Content-Type": "application/json",
};
}

  const headers = corsHeaders(event.headers?.origin);

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };

  // Optional: associate every lead/deal to a single exclusive vendor (Company record)
  const EXCLUSIVE_VENDOR_COMPANY_ID = String(process.env.EXCLUSIVE_VENDOR_COMPANY_ID || "").trim();
  if (!HS_TOKEN) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
  }

  // Optional pipeline/stage controls (if you want)
  const DEAL_PIPELINE_ID = String(process.env.DEAL_PIPELINE_ID || "").trim();
  const DEAL_STAGE_ID_NEW = String(process.env.DEAL_STAGE_ID_NEW || "").trim();
  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

async function readText(res) { try { return await res.text(); } catch { return ""; } }
async function fetchJson(url, options = {}) {
const res = await fetch(url, options);
const text = await readText(res);
let json = null;
try { json = text ? JSON.parse(text) : null; } catch { json = null; }
return { ok: res.ok, status: res.status, json, text };
}

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  const hsGet = (path) => fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: hsAuth });
  const hsPost = (path, body) => fetchJson(`https://api.hubapi.com${path}`, {
    method: "POST",
    headers: { ...hsAuth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const hsPatch = (path, body) => fetchJson(`https://api.hubapi.com${path}`, {
    method: "PATCH",
    headers: { ...hsAuth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const hsPut = (path, body, extraHeaders = {}) => fetchJson(`https://api.hubapi.com${path}`, {
    method: "PUT",
    headers: { ...hsAuth, "Content-Type": "application/json", ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });

  // --- Deal property existence cache (avoids PATCH failures for missing custom props)
  const propExistsCache = new Map();
  async function dealPropExists(name) {
    if (!name) return false;
    if (propExistsCache.has(name)) return propExistsCache.get(name);
    const r = await hsGet(`/crm/v3/properties/deals/${encodeURIComponent(name)}`);
    propExistsCache.set(name, !!r.ok);
    return !!r.ok;
  async function hsGet(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: hsAuth });
}

  function safeNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  async function hsPost(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
}

  function zip3xx(zip) {
    const m = String(zip || "").match(/\b(\d{3})\d{2}\b/);
    return m ? `${m[1]}xx` : "";
  async function hsPatch(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "PATCH",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
}

  function redactedLocationFromPayload(payload) {
    const city = String(payload.city || payload.addr_city || "").trim();
    const zip = String(payload.postal_code || payload.addr_zip || payload.zip || "").trim();
    const z3 = zip3xx(zip);
    // Requirement: "display city name and first3 digits of zip ending in XX"
    // => City + " " + 300xx
    return [city, z3].filter(Boolean).join(" ").trim();
  async function hsPut(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "PUT", headers: hsAuth });
}

  // --- Pricing model (risk tier + selection value)
  function computeLeadPrice({ payload, risk }) {
    // Primary driver: risk score (0-100)
    const riskScore = Math.max(0, Math.min(100,
      Math.round(safeNum(payload.hsc_risk_score ?? risk?.scoring?.riskScore ?? 0))
    ));
  // ---------- cache deal property names (avoid PROPERTY_DOESNT_EXIST errors) ----------
  let _dealPropsCache = globalThis.__HSC_DEAL_PROPS_CACHE || null;
  async function getDealPropertyNames() {
    const now = Date.now();
    if (_dealPropsCache && (now - _dealPropsCache.ts) < 5 * 60 * 1000) return _dealPropsCache.map;

    // returns array of properties in most portals
    const r = await hsGet("/crm/v3/properties/deals");
    const arr = Array.isArray(r.json) ? r.json : (Array.isArray(r.json?.results) ? r.json.results : []);
    const map = {};
    for (const p of arr) {
      if (p?.name) map[p.name] = true;
    }
    _dealPropsCache = { ts: now, map };
    globalThis.__HSC_DEAL_PROPS_CACHE = _dealPropsCache;
    return map;
  }

    // Selection value proxy: upfront + 12*monthly (first-year value)
    const upfront = safeNum(payload.hsc_upfront ?? payload.upfront);
    const monthly = safeNum(payload.hsc_monthly ?? payload.monthly);
    const firstYearValue = upfront + (monthly * 12);
  function onlyExistingProps(propMap, props) {
    const out = {};
    for (const [k, v] of Object.entries(props || {})) {
      if (propMap[k]) out[k] = v;
    }
    return out;
  }

    // Intent modifiers
    const timeline = String(payload.time_line || payload.timeline || "").toLowerCase();
    const ownership = String(payload.home_ownership || payload.ownership || "").toLowerCase();
  // ---------- associations (get associationTypeId dynamically) ----------
  let _assocCache = globalThis.__HSC_ASSOC_CACHE || {};
  async function getAssociationTypeId(fromType, toType) {
    const key = `${fromType}->${toType}`;
    const now = Date.now();
    const cached = _assocCache[key];
    if (cached && (now - cached.ts) < 60 * 60 * 1000) return cached.id;

    const r = await hsGet(`/crm/v4/associations/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/labels`);
    const results = Array.isArray(r.json?.results) ? r.json.results : [];
    // prefer HUBSPOT_DEFINED default association
    const pick =
      results.find(x => String(x?.category || "").toUpperCase() === "HUBSPOT_DEFINED") ||
      results[0];

    const id = pick?.typeId || pick?.associationTypeId || pick?.id;
    if (!id) throw new Error(`Could not resolve associationTypeId for ${fromType} -> ${toType}`);

    _assocCache[key] = { ts: now, id: Number(id) };
    globalThis.__HSC_ASSOC_CACHE = _assocCache;
    return Number(id);
  }

    // Tier base (lead-gen style: higher urgency/need => higher base)
    let base;
    if (riskScore >= 80) base = 220;
    else if (riskScore >= 65) base = 160;
    else if (riskScore >= 45) base = 110;
    else base = 75;
  async function associate(fromType, fromId, toType, toId) {
    const typeId = await getAssociationTypeId(fromType, toType);
    // v3 association create
    return hsPut(`/crm/v3/objects/${encodeURIComponent(fromType)}/${encodeURIComponent(fromId)}/associations/${encodeURIComponent(toType)}/${encodeURIComponent(toId)}/${typeId}`);
  }

    // Scale with selection value (cap so it doesn't explode)
    // Example: $0-$10k selection => +0% to +40%
    const valueBoost = Math.min(0.40, Math.max(0, firstYearValue / 10000) * 0.40);
    let price = base * (1 + valueBoost);
  // ---------- helpers ----------
  function safeStr(v) { return String(v ?? "").trim(); }
  function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

    // Timeline bump (ASAP / soon)
    if (timeline.includes("asap") || timeline.includes("now") || timeline.includes("immediate")) price *= 1.25;
    else if (timeline.includes("1") || timeline.includes("2") || timeline.includes("3") || timeline.includes("month")) price *= 1.12;
  function zip3xx(zip) {
    const m = String(zip || "").match(/\b(\d{3})\d{2}\b/);
    return m ? `${m[1]}xx` : "";
  }

    // Ownership bump (homeowners tend to convert better)
    if (ownership.includes("own")) price *= 1.08;
  function parseCityStateZipFromFormatted(addr) {
    // "5935 Memorial Dr, Stone Mountain, GA 30083, USA"
    const s = String(addr || "");
    const m = s.match(/,\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})\b/);
    if (!m) return { city: "", state: "", zip: "" };
    return { city: (m[1] || "").trim(), state: (m[2] || "").trim(), zip: (m[3] || "").trim() };
  }

    // Floor/ceiling
    price = Math.max(59, Math.min(399, price));
  function redactedLocation(payload) {
    const city =
      safeStr(payload.city) ||
      safeStr(payload.addr_city) ||
      safeStr(payload.geo?.city) ||
      parseCityStateZipFromFormatted(payload.hsc_property_address || payload.address).city;

    const st =
      safeStr(payload.state_code) ||
      safeStr(payload.addr_state) ||
      safeStr(payload.geo?.state) ||
      parseCityStateZipFromFormatted(payload.hsc_property_address || payload.address).state;

    const zip =
      safeStr(payload.postal_code) ||
      safeStr(payload.addr_zip) ||
      safeStr(payload.geo?.zip) ||
      parseCityStateZipFromFormatted(payload.hsc_property_address || payload.address).zip;

    return {
      riskScore,
      upfront,
      monthly,
      firstYearValue,
      leadPrice: Math.round(price),
    };
    const z3 = zip3xx(zip);
    const base = [city, st].filter(Boolean).join(", ").trim();
    return (base ? base : "Unknown") + (z3 ? ` ${z3}` : "");
}

  // --- Flatten to CSV text for deal description fallback
  function toCsvRows(obj, prefix = "", out = []) {
    if (obj == null) return out;
  // Lead-price logic:
  // - risk tier multiplier
  // - plus a small portion of config value (upfront + monthly)
  // - clamps to realistic exclusive-lead range
  function computeLeadPrice({ riskScore, upfront, monthly, deviceCount }) {
    const rs = safeNum(riskScore);
    const tierMult = rs >= 70 ? 1.35 : rs >= 40 ? 1.10 : 0.90;

    // Avoid huge blobs (e.g., raw addressComponents arrays)
    const isPlain = Object.prototype.toString.call(obj) === "[object Object]";
    if (!isPlain) {
      out.push([prefix, String(obj)]);
      return out;
    }
    // "selection value" factor: higher system cost -> more likely buyer -> higher lead value
    const selectionValue = (safeNum(upfront) * 0.02) + (safeNum(monthly) * 1.2) + (safeNum(deviceCount) * 1.0);

    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
    const base = 35; // exclusive home-services lead baseline
    let price = (base + selectionValue) * tierMult;

      if (v == null) {
        out.push([key, ""]);
        continue;
      }
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out.push([key, String(v)]);
        continue;
      }
      if (Array.isArray(v)) {
        // arrays: keep short
        const short = v.slice(0, 20).map(x => {
          if (x == null) return "";
          if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return String(x);
          return "[obj]";
        }).join("|");
        out.push([key, short]);
        continue;
      }
      // object
      toCsvRows(v, key, out);
    }
    return out;
  }
    // round to nearest $5
    price = Math.round(price / 5) * 5;

  function csvEscape(s) {
    const v = String(s ?? "");
    return /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    // clamp
    price = Math.max(25, Math.min(250, price));
    return price;
}

  function buildDealDescriptionCsv(payload, risk) {
    const rows = [];
    toCsvRows({ payload, risk }, "", rows);

    const head = [
      "key,value",
      ...rows.map(([k, v]) => `${csvEscape(k)},${csvEscape(v)}`)
    ].join("\n");

    return [
      "=== HSC Payload + Risk (CSV) ===",
      head,
      "",
      "=== End ==="
    ].join("\n");
  function payloadToCsvKV(payload) {
    // 2-column CSV: key,value (safe for deal description)
    const rows = [["key", "value"]];
    const flatten = (obj, prefix = "") => {
      if (!obj || typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key);
        else rows.push([key, Array.isArray(v) ? JSON.stringify(v) : String(v ?? "")]);
      }
    };
    flatten(payload);
    const esc = (s) => {
      const t = String(s ?? "");
      return /[,"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    return rows.map(r => r.map(esc).join(",")).join("\n");
}

async function findDealByLeadId(leadId) {
    if (!leadId) return null;
const r = await hsPost("/crm/v3/objects/deals/search", {
filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["dealname", "amount", "lead_id"],
      properties: ["lead_id", "dealname", "amount", "description", "listing_status"],
limit: 1,
});
    return r.ok && r.json?.results?.[0] ? r.json.results[0] : null;
  }

  async function ensureVendorAssociation(dealId) {
    if (!EXCLUSIVE_VENDOR_COMPANY_ID || !dealId) return;
    // Try v4 default association (no body)
    // We'll try plural & singular forms for robustness.
    const tries = [
      `/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/default/companies/${encodeURIComponent(EXCLUSIVE_VENDOR_COMPANY_ID)}`,
      `/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/default/company/${encodeURIComponent(EXCLUSIVE_VENDOR_COMPANY_ID)}`,
    ];
    for (const p of tries) {
      const r = await fetchJson(`https://api.hubapi.com${p}`, { method: "PUT", headers: hsAuth });
      if (r.ok) return;
    }
    return (r.ok && r.json?.results?.[0]) ? r.json.results[0] : null;
}

  async function listDealLineItems(dealId) {
    // v3 association list
    const r = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items?limit=100`);
    const ids = (r.ok && Array.isArray(r.json?.results)) ? r.json.results.map(x => String(x?.id || x).trim()).filter(Boolean) : [];
    return ids;
  async function getFirstLineItemIdForDeal(dealId) {
    const r = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items?limit=10`);
    const results = Array.isArray(r.json?.results) ? r.json.results : [];
    const first = results[0]?.id || results[0];
    return first ? String(first) : "";
}

  async function createLineItem({ name, price }) {
    const r = await hsPost("/crm/v3/objects/line_items", {
      properties: {
        name: String(name || "Home Secure Lead"),
        quantity: "1",
        price: String(Math.round(safeNum(price))),
  async function createOrUpdateLineItemForDeal({ dealId, lineItemName, price }) {
    // Try existing association
    let lineItemId = await getFirstLineItemIdForDeal(dealId);

    if (!lineItemId) {
      // Create new line item
      const created = await hsPost("/crm/v3/objects/line_items", {
        properties: {
          name: lineItemName,
          quantity: "1",
          price: String(price),
        },
      });
      if (!created.ok || !created.json?.id) {
        throw new Error("Line item create failed: " + (created.text || "unknown"));
}
    });
    if (!r.ok || !r.json?.id) throw new Error("Line item create failed: " + (r.text || ""));
    return String(r.json.id);
  }
      lineItemId = String(created.json.id);

  async function patchLineItem(lineItemId, { name, price }) {
    return hsPatch(`/crm/v3/objects/line_items/${encodeURIComponent(lineItemId)}`, {
      properties: {
        name: String(name || "Home Secure Lead"),
        quantity: "1",
        price: String(Math.round(safeNum(price))),
      // Associate line item -> deal
      const assoc = await associate("line_items", lineItemId, "deals", dealId);
      if (!assoc.ok) {
        throw new Error("Line item association failed: " + (assoc.text || "unknown"));
      }
    } else {
      // Update existing line item price/name
      const patched = await hsPatch(`/crm/v3/objects/line_items/${encodeURIComponent(lineItemId)}`, {
        properties: {
          name: lineItemName,
          price: String(price),
          quantity: "1",
        },
      });
      if (!patched.ok) {
        // don’t hard fail; just return line item id
}
    });
  }

  async function associateLineItemToDeal(lineItemId, dealId) {
    const paths = [
      `/crm/v4/objects/line_items/${encodeURIComponent(lineItemId)}/associations/default/deals/${encodeURIComponent(dealId)}`,
      `/crm/v4/objects/line_items/${encodeURIComponent(lineItemId)}/associations/default/deal/${encodeURIComponent(dealId)}`,
    ];
    for (const p of paths) {
      const r = await fetchJson(`https://api.hubapi.com${p}`, { method: "PUT", headers: hsAuth });
      if (r.ok) return true;
    }
    return false;
  }

  async function ensureLineItemForDeal({ dealId, dealName, leadPrice }) {
    const existing = await listDealLineItems(dealId);

    if (existing.length) {
      const lineItemId = existing[0];
      const patched = await patchLineItem(lineItemId, { name: dealName || "Home Secure Lead", price: leadPrice });
      if (!patched.ok) throw new Error("Line item update failed: " + (patched.text || ""));
      return lineItemId;
}

    const lineItemId = await createLineItem({ name: dealName || "Home Secure Lead", price: leadPrice });
    const okAssoc = await associateLineItemToDeal(lineItemId, dealId);
    if (!okAssoc) throw new Error("Line item association to deal failed");
return lineItemId;
}

try {
const body = JSON.parse(event.body || "{}");
    const payloadIn = (body.payload && typeof body.payload === "object") ? body.payload : body;
    const risk = body.risk || null;
    const payloadIn = (body && typeof body.payload === "object") ? body.payload : {};
    const riskIn = (body && typeof body.risk === "object") ? body.risk : null;

    const payload = { ...(payloadIn || {}) };
    // normalize payload
    const payload = { ...payloadIn };
    payload.lead_id = safeStr(payload.lead_id) || (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2));
    payload.email = safeStr(payload.email);
    payload.time_line = safeStr(payload.time_line) || "Researching";
    payload.home_ownership = safeStr(payload.home_ownership) || "Unknown";

    const leadId = String(payload.lead_id || body.lead_id || "").trim();
    if (!leadId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing lead_id" }) };
    }
    // We want Deal name = "City, ST 300xx" (NO "Location")
    const redacted = redactedLocation(payload);
    const dealName = `${redacted}`;

    // Derive dealname "City 300xx"
    const redLoc = redactedLocationFromPayload(payload);
    const dealName = (redLoc ? redLoc : "Unknown 000xx").trim();
    // Pricing inputs
    const upfront = safeNum(payload.hsc_upfront ?? payload.upfront);
    const monthly = safeNum(payload.hsc_monthly ?? payload.monthly);
    const riskScore =
      safeNum(payload.hsc_risk_score) ||
      safeNum(riskIn?.scoring?.riskScore);

    const deviceCount =
      safeNum(payload.indoorCam) +
      safeNum(payload.outdoorCam) +
      safeNum(payload.doorbell) +
      safeNum(payload.lock);

    const leadPrice = computeLeadPrice({ riskScore, upfront, monthly, deviceCount });

    // Make description CSV (full payload)
    const payloadCsv = payloadToCsvKV({
      ...payload,
      __computed__: {
        redacted_location: redacted,
        computed_lead_price: leadPrice,
        computed_at: new Date().toISOString(),
      }
    });

    // Lead price
    const pricing = computeLeadPrice({ payload, risk });
    // Find or create Deal
    let deal = await findDealByLeadId(payload.lead_id);
    let dealId = deal?.id ? String(deal.id) : "";

    // Build deal description CSV (always safe)
    const descriptionCsv = buildDealDescriptionCsv(payload, risk);
    const dealPropsMap = await getDealPropertyNames();

    // Build properties (only send props that exist to avoid validation errors)
    const props = {
    // Deal properties we *want* (but only set if they exist to avoid validation errors)
    const desiredDealProps = {
      lead_id: payload.lead_id,
dealname: dealName,
      amount: String(pricing.leadPrice),
      description: descriptionCsv,
      lead_id: leadId,
      // common custom names (only set if they exist)
      redacted_location: redLoc,
      hsc_risk_score: String(pricing.riskScore),
      hsc_upfront: String(pricing.upfront),
      hsc_monthly: String(pricing.monthly),
      hsc_property_address: String(payload.hsc_property_address || payload.address || ""),
      hsc_devices: String(payload.hsc_devices || payload.deviceSummary || payload.selectedItems || ""),
      lead_price: String(pricing.leadPrice),
      listing_status: String(payload.listing_status || "Unpaid"),
      amount: String(leadPrice),
      description: payloadCsv,
      // optional: you can create this custom property; if it exists we’ll set it
      listing_status: "Listing Created",
};

    const finalProps = {};
    // always include standard props
    finalProps.dealname = props.dealname;
    finalProps.amount = props.amount;
    finalProps.description = props.description;

    // optional standard pipeline/stage if set
    if (DEAL_PIPELINE_ID) finalProps.pipeline = DEAL_PIPELINE_ID;
    if (DEAL_STAGE_ID_NEW) finalProps.dealstage = DEAL_STAGE_ID_NEW;

    // include custom props only if they exist
    for (const k of Object.keys(props)) {
      if (k === "dealname" || k === "amount" || k === "description") continue;
      if (await dealPropExists(k)) finalProps[k] = String(props[k] ?? "");
    }

    // Locate existing deal or create new
    let dealId = String(payload.deal_id || body.deal_id || "").trim();
    const filteredDealProps = onlyExistingProps(dealPropsMap, desiredDealProps);

if (!dealId) {
      const found = await findDealByLeadId(leadId);
      if (found?.id) dealId = String(found.id);
    }

    if (dealId) {
      const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: finalProps });
      if (!patched.ok) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Deal update failed", detail: patched.text }) };
      }
    } else {
      const created = await hsPost("/crm/v3/objects/deals", { properties: finalProps });
      const created = await hsPost("/crm/v3/objects/deals", { properties: filteredDealProps });
if (!created.ok || !created.json?.id) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Deal create failed", detail: created.text }) };
        return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal create failed", detail: created.text }) };
}
dealId = String(created.json.id);
    } else {
      const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: filteredDealProps });
      if (!patched.ok) {
        return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal update failed", detail: patched.text }) };
      }
}

    // Exclusive vendor association (optional)
    await ensureVendorAssociation(dealId);

    // Ensure line item matches amount
    const lineItemId = await ensureLineItemForDeal({ dealId, dealName, leadPrice: pricing.leadPrice });
    // Ensure Line Item exists and matches lead price
    const lineItemName = `Exclusive Lead — ${redacted}`;
    const lineItemId = await createOrUpdateLineItemForDeal({ dealId, lineItemName, price: leadPrice });

    // Store line item id if you created that property
    if (await dealPropExists("hsc_line_item_id")) {
      await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
        properties: { hsc_line_item_id: String(lineItemId) }
      });
    // Backstop: set deal amount to exact lead price again
    if (dealPropsMap.amount) {
      await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: { amount: String(leadPrice) } });
}

return {
statusCode: 200,
      headers,
      headers: corsHeaders(event.headers?.origin),
body: JSON.stringify({
ok: true,
        lead_id: leadId,
        lead_id: payload.lead_id,
deal_id: dealId,
        dealname: dealName,
        amount: pricing.leadPrice,
line_item_id: lineItemId,
        pricing,
      })
        dealname: dealName,
        amount: leadPrice,
      }),
};
} catch (err) {
console.error("hubspot-sync error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err?.message || err) }) };
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
}
}
