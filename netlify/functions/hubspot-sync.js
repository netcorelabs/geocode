// netlify/functions/hubspot-sync.js
export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "http://www.homesecurecalculator.com",
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

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };

  // Optional: associate every lead/deal to a single exclusive vendor (Company record)
  const EXCLUSIVE_VENDOR_COMPANY_ID = String(process.env.EXCLUSIVE_VENDOR_COMPANY_ID || "").trim();

  // Optional pipeline/stage controls (if you want)
  const DEAL_PIPELINE_ID = String(process.env.DEAL_PIPELINE_ID || "").trim();
  const DEAL_STAGE_ID_NEW = String(process.env.DEAL_STAGE_ID_NEW || "").trim();

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
  }

  function safeNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function zip3xx(zip) {
    const m = String(zip || "").match(/\b(\d{3})\d{2}\b/);
    return m ? `${m[1]}xx` : "";
  }

  function redactedLocationFromPayload(payload) {
    const city = String(payload.city || payload.addr_city || "").trim();
    const zip = String(payload.postal_code || payload.addr_zip || payload.zip || "").trim();
    const z3 = zip3xx(zip);
    // Requirement: "display city name and first3 digits of zip ending in XX"
    // => City + " " + 300xx
    return [city, z3].filter(Boolean).join(" ").trim();
  }

  // --- Pricing model (risk tier + selection value)
  function computeLeadPrice({ payload, risk }) {
    // Primary driver: risk score (0-100)
    const riskScore = Math.max(0, Math.min(100,
      Math.round(safeNum(payload.hsc_risk_score ?? risk?.scoring?.riskScore ?? 0))
    ));

    // Selection value proxy: upfront + 12*monthly (first-year value)
    const upfront = safeNum(payload.hsc_upfront ?? payload.upfront);
    const monthly = safeNum(payload.hsc_monthly ?? payload.monthly);
    const firstYearValue = upfront + (monthly * 12);

    // Intent modifiers
    const timeline = String(payload.time_line || payload.timeline || "").toLowerCase();
    const ownership = String(payload.home_ownership || payload.ownership || "").toLowerCase();

    // Tier base (lead-gen style: higher urgency/need => higher base)
    let base;
    if (riskScore >= 80) base = 220;
    else if (riskScore >= 65) base = 160;
    else if (riskScore >= 45) base = 110;
    else base = 75;

    // Scale with selection value (cap so it doesn't explode)
    // Example: $0-$10k selection => +0% to +40%
    const valueBoost = Math.min(0.40, Math.max(0, firstYearValue / 10000) * 0.40);
    let price = base * (1 + valueBoost);

    // Timeline bump (ASAP / soon)
    if (timeline.includes("asap") || timeline.includes("now") || timeline.includes("immediate")) price *= 1.25;
    else if (timeline.includes("1") || timeline.includes("2") || timeline.includes("3") || timeline.includes("month")) price *= 1.12;

    // Ownership bump (homeowners tend to convert better)
    if (ownership.includes("own")) price *= 1.08;

    // Floor/ceiling
    price = Math.max(59, Math.min(399, price));

    return {
      riskScore,
      upfront,
      monthly,
      firstYearValue,
      leadPrice: Math.round(price),
    };
  }

  // --- Flatten to CSV text for deal description fallback
  function toCsvRows(obj, prefix = "", out = []) {
    if (obj == null) return out;

    // Avoid huge blobs (e.g., raw addressComponents arrays)
    const isPlain = Object.prototype.toString.call(obj) === "[object Object]";
    if (!isPlain) {
      out.push([prefix, String(obj)]);
      return out;
    }

    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;

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

  function csvEscape(s) {
    const v = String(s ?? "");
    return /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
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
  }

  async function findDealByLeadId(leadId) {
    if (!leadId) return null;
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["dealname", "amount", "lead_id"],
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
  }

  async function listDealLineItems(dealId) {
    // v3 association list
    const r = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items?limit=100`);
    const ids = (r.ok && Array.isArray(r.json?.results)) ? r.json.results.map(x => String(x?.id || x).trim()).filter(Boolean) : [];
    return ids;
  }

  async function createLineItem({ name, price }) {
    const r = await hsPost("/crm/v3/objects/line_items", {
      properties: {
        name: String(name || "Home Secure Lead"),
        quantity: "1",
        price: String(Math.round(safeNum(price))),
      }
    });
    if (!r.ok || !r.json?.id) throw new Error("Line item create failed: " + (r.text || ""));
    return String(r.json.id);
  }

  async function patchLineItem(lineItemId, { name, price }) {
    return hsPatch(`/crm/v3/objects/line_items/${encodeURIComponent(lineItemId)}`, {
      properties: {
        name: String(name || "Home Secure Lead"),
        quantity: "1",
        price: String(Math.round(safeNum(price))),
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

    const payload = { ...(payloadIn || {}) };

    const leadId = String(payload.lead_id || body.lead_id || "").trim();
    if (!leadId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing lead_id" }) };
    }

    // Derive dealname "City 300xx"
    const redLoc = redactedLocationFromPayload(payload);
    const dealName = (redLoc ? redLoc : "Unknown 000xx").trim();

    // Lead price
    const pricing = computeLeadPrice({ payload, risk });

    // Build deal description CSV (always safe)
    const descriptionCsv = buildDealDescriptionCsv(payload, risk);

    // Build properties (only send props that exist to avoid validation errors)
    const props = {
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
      if (!created.ok || !created.json?.id) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Deal create failed", detail: created.text }) };
      }
      dealId = String(created.json.id);
    }

    // Exclusive vendor association (optional)
    await ensureVendorAssociation(dealId);

    // Ensure line item matches amount
    const lineItemId = await ensureLineItemForDeal({ dealId, dealName, leadPrice: pricing.leadPrice });

    // Store line item id if you created that property
    if (await dealPropExists("hsc_line_item_id")) {
      await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
        properties: { hsc_line_item_id: String(lineItemId) }
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        lead_id: leadId,
        deal_id: dealId,
        dealname: dealName,
        amount: pricing.leadPrice,
        line_item_id: lineItemId,
        pricing,
      })
    };
  } catch (err) {
    console.error("hubspot-sync error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
