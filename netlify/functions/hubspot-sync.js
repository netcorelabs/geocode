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

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
  }

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  async function hsGet(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: hsAuth });
  }
  async function hsPost(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function hsPatch(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "PATCH",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function hsPut(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "PUT", headers: hsAuth });
  }

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

  function onlyExistingProps(propMap, props) {
    const out = {};
    for (const [k, v] of Object.entries(props || {})) {
      if (propMap[k]) out[k] = v;
    }
    return out;
  }

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

  async function associate(fromType, fromId, toType, toId) {
    const typeId = await getAssociationTypeId(fromType, toType);
    // v3 association create
    return hsPut(`/crm/v3/objects/${encodeURIComponent(fromType)}/${encodeURIComponent(fromId)}/associations/${encodeURIComponent(toType)}/${encodeURIComponent(toId)}/${typeId}`);
  }

  // ---------- helpers ----------
  function safeStr(v) { return String(v ?? "").trim(); }
  function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  function zip3xx(zip) {
    const m = String(zip || "").match(/\b(\d{3})\d{2}\b/);
    return m ? `${m[1]}xx` : "";
  }

  function parseCityStateZipFromFormatted(addr) {
    // "5935 Memorial Dr, Stone Mountain, GA 30083, USA"
    const s = String(addr || "");
    const m = s.match(/,\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})\b/);
    if (!m) return { city: "", state: "", zip: "" };
    return { city: (m[1] || "").trim(), state: (m[2] || "").trim(), zip: (m[3] || "").trim() };
  }

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

    const z3 = zip3xx(zip);
    const base = [city, st].filter(Boolean).join(", ").trim();
    return (base ? base : "Unknown") + (z3 ? ` ${z3}` : "");
  }

  // Lead-price logic:
  // - risk tier multiplier
  // - plus a small portion of config value (upfront + monthly)
  // - clamps to realistic exclusive-lead range
  function computeLeadPrice({ riskScore, upfront, monthly, deviceCount }) {
    const rs = safeNum(riskScore);
    const tierMult = rs >= 70 ? 1.35 : rs >= 40 ? 1.10 : 0.90;

    // "selection value" factor: higher system cost -> more likely buyer -> higher lead value
    const selectionValue = (safeNum(upfront) * 0.02) + (safeNum(monthly) * 1.2) + (safeNum(deviceCount) * 1.0);

    const base = 35; // exclusive home-services lead baseline
    let price = (base + selectionValue) * tierMult;

    // round to nearest $5
    price = Math.round(price / 5) * 5;

    // clamp
    price = Math.max(25, Math.min(250, price));
    return price;
  }

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
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id", "dealname", "amount", "description", "listing_status"],
      limit: 1,
    });
    return (r.ok && r.json?.results?.[0]) ? r.json.results[0] : null;
  }

  async function getFirstLineItemIdForDeal(dealId) {
    const r = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items?limit=10`);
    const results = Array.isArray(r.json?.results) ? r.json.results : [];
    const first = results[0]?.id || results[0];
    return first ? String(first) : "";
  }

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
      lineItemId = String(created.json.id);

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
    }

    return lineItemId;
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const payloadIn = (body && typeof body.payload === "object") ? body.payload : {};
    const riskIn = (body && typeof body.risk === "object") ? body.risk : null;

    // normalize payload
    const payload = { ...payloadIn };
    payload.lead_id = safeStr(payload.lead_id) || (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2));
    payload.email = safeStr(payload.email);
    payload.time_line = safeStr(payload.time_line) || "Researching";
    payload.home_ownership = safeStr(payload.home_ownership) || "Unknown";

    // We want Deal name = "City, ST 300xx" (NO "Location")
    const redacted = redactedLocation(payload);
    const dealName = `${redacted}`;

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

    // Find or create Deal
    let deal = await findDealByLeadId(payload.lead_id);
    let dealId = deal?.id ? String(deal.id) : "";

    const dealPropsMap = await getDealPropertyNames();

    // Deal properties we *want* (but only set if they exist to avoid validation errors)
    const desiredDealProps = {
      lead_id: payload.lead_id,
      dealname: dealName,
      amount: String(leadPrice),
      description: payloadCsv,
      // optional: you can create this custom property; if it exists we’ll set it
      listing_status: "Listing Created",
    };

    const filteredDealProps = onlyExistingProps(dealPropsMap, desiredDealProps);

    if (!dealId) {
      const created = await hsPost("/crm/v3/objects/deals", { properties: filteredDealProps });
      if (!created.ok || !created.json?.id) {
        return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal create failed", detail: created.text }) };
      }
      dealId = String(created.json.id);
    } else {
      const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: filteredDealProps });
      if (!patched.ok) {
        return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal update failed", detail: patched.text }) };
      }
    }

    // Ensure Line Item exists and matches lead price
    const lineItemName = `Exclusive Lead — ${redacted}`;
    const lineItemId = await createOrUpdateLineItemForDeal({ dealId, lineItemName, price: leadPrice });

    // Backstop: set deal amount to exact lead price again
    if (dealPropsMap.amount) {
      await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: { amount: String(leadPrice) } });
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        lead_id: payload.lead_id,
        deal_id: dealId,
        line_item_id: lineItemId,
        dealname: dealName,
        amount: leadPrice,
      }),
    };
  } catch (err) {
    console.error("hubspot-sync error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
