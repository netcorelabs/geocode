// netlify/functions/ensure-line-item.js
// FULL DROP-IN (2026-02)
// Purpose:
// - Ensure a Deal has a correctly-priced Line Item associated
// - Set Deal Amount = Lead Price
// - Set Deal Name = "City, ST 123xx" (no word "Location")
// - Safe against missing custom properties (checks before patch)
// - Uses HubSpot v4 association labels to avoid wrong association names

export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
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
    return {
      statusCode: 405,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) {
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }),
    };
  }

  // Optional: force USD for line items
  const DEFAULT_CURRENCY = String(process.env.HSC_CURRENCY_CODE || "USD").trim() || "USD";

  async function readText(res) {
    try { return await res.text(); } catch { return ""; }
  }

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
  const hsPut = (path) => fetchJson(`https://api.hubapi.com${path}`, { method: "PUT", headers: hsAuth });

  function safeNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function zip3(zip) {
    const m = String(zip || "").match(/\b(\d{3})\d{2}\b/);
    return m ? m[1] : "";
  }

  function buildRedactedLocation(payload) {
    const city = String(payload?.city || payload?.hs_city || "").trim();
    const st = String(payload?.state_code || payload?.state || payload?.hs_state || "").trim();
    const zip = String(payload?.postal_code || payload?.zip || payload?.hs_zip || "").trim();
    const z3 = zip3(zip);

    const base = [city, st].filter(Boolean).join(", ");
    if (!base && z3) return `${z3}xx`;
    if (!base) return "Unknown";
    return base + (z3 ? ` ${z3}xx` : "");
  }

  function sumDeviceCount(payload) {
    if (Array.isArray(payload?.deviceLines)) {
      return payload.deviceLines.reduce((a, d) => a + safeNum(d?.qty), 0);
    }

    const str = String(payload?.hsc_devices || payload?.deviceSummary || payload?.selectedItems || "");
    let total = 0;
    str.split(",").map(s => s.trim()).filter(Boolean).forEach(part => {
      const m = part.match(/x\s*(\d+)$/i);
      if (m) total += safeNum(m[1]);
    });

    const keys = ["indoorCam","outdoorCam","doorbell","lock","doorSensor","windowSensor","motion","glass","smoke","water","keypad","siren"];
    const byKeys = keys.reduce((a, k) => a + safeNum(payload?.[k]), 0);

    return Math.max(total, byKeys);
  }

  function normalizeTimeline(payload) {
    return String(payload?.time_line || payload?.timeline || payload?.timeLine || "").toLowerCase();
  }

  function computeLeadTier(score) {
    const s = Math.max(0, Math.min(100, Math.round(safeNum(score))));
    if (s >= 85) return { tier: "Premium", base: 200 };
    if (s >= 70) return { tier: "High-Intent", base: 125 };
    if (s >= 50) return { tier: "Qualified", base: 75 };
    if (s >= 25) return { tier: "Standard", base: 50 };
    return { tier: "Basic", base: 30 };
  }

  // Industry-style pricing:
  // - Risk tier base price
  // - + bump for configuration value
  // - + bump for device count
  // - + bump for urgency
  function computeLeadPrice(payload) {
    const riskScore = safeNum(payload?.hsc_risk_score ?? payload?.risk_score ?? payload?.riskScore);
    const { tier, base } = computeLeadTier(riskScore);

    const upfront = safeNum(payload?.hsc_upfront ?? payload?.upfront);
    const monthly = safeNum(payload?.hsc_monthly ?? payload?.monthly);
    const selectionValue = upfront + (monthly * 12);

    const deviceCount = sumDeviceCount(payload);

    const selectionAdd = Math.min(75, Math.round(selectionValue * 0.004)); // cap
    const deviceAdd = Math.min(25, Math.round(deviceCount * 2));           // cap

    const tl = normalizeTimeline(payload);
    let urgencyAdd = 0;
    if (/(asap|now|urgent|immediately|0\s*-\s*30|0-30|today)/i.test(tl)) urgencyAdd = 20;
    else if (/(1\s*-\s*3\s*month|1-3\s*month|30\s*-\s*90|30-90)/i.test(tl)) urgencyAdd = 10;

    const price = Math.max(19, base + selectionAdd + deviceAdd + urgencyAdd);

    return {
      tier,
      price: Math.round(price),
      components: { base, selectionAdd, deviceAdd, urgencyAdd, selectionValue, deviceCount, riskScore }
    };
  }

  async function dealPropertyExists(name) {
    const r = await hsGet(`/crm/v3/properties/deals/${encodeURIComponent(name)}`);
    return r.ok;
  }

  async function patchDealSafe(dealId, properties) {
    const safeProps = {};
    const always = ["dealname", "amount"]; // built-ins always exist

    for (const k of always) {
      if (properties[k] != null) safeProps[k] = String(properties[k]);
    }

    const optionalKeys = Object.keys(properties).filter(k => !always.includes(k));
    const checks = await Promise.all(optionalKeys.map(async (k) => ({ k, ok: await dealPropertyExists(k) })));

    for (const c of checks) {
      if (c.ok) safeProps[c.k] = String(properties[c.k]);
    }

    return hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: safeProps });
  }

  async function getLineItemDealAssocTypeId() {
    const r = await hsGet(`/crm/v4/associations/line_items/deals/labels`);
    if (!r.ok || !Array.isArray(r.json?.results) || !r.json.results.length) return null;
    const results = r.json.results;
    const best = results.find(x => String(x.label || "").toLowerCase().includes("line_item_to_deal")) || results[0];
    return Number(best.associationTypeId || 0) || null;
  }

  async function listDealLineItems(dealId) {
    const r = await hsGet(`/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/line_items?limit=100`);
    if (!r.ok) return [];
    const arr = Array.isArray(r.json?.results) ? r.json.results : [];
    return arr.map(x => String(x.toObjectId || "").trim()).filter(Boolean);
  }

  async function associateLineItemToDeal(lineItemId, dealId, assocTypeId) {
    if (assocTypeId) {
      return hsPut(`/crm/v4/objects/line_items/${encodeURIComponent(lineItemId)}/associations/deals/${encodeURIComponent(dealId)}/${encodeURIComponent(String(assocTypeId))}`);
    }
    // fallback
    return hsPut(`/crm/v3/objects/line_items/${encodeURIComponent(lineItemId)}/associations/deals/${encodeURIComponent(dealId)}/line_item_to_deal`);
  }

  async function createLineItem(props) {
    return hsPost(`/crm/v3/objects/line_items`, { properties: props });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const deal_id = String(body.deal_id || "").trim();
    const lead_id = String(body.lead_id || body.payload?.lead_id || "").trim();
    const payload = (body.payload && typeof body.payload === "object") ? body.payload : {};

    if (!deal_id) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id" }) };
    }

    // Verify deal exists
    const dealRead = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(deal_id)}?properties=dealname,amount,lead_id`);
    if (!dealRead.ok || !dealRead.json?.id) {
      return { statusCode: 404, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal not found", deal_id, detail: dealRead.text }) };
    }

    // Compute pricing + naming
    const redacted = buildRedactedLocation(payload);
    const pricing = computeLeadPrice(payload);

    // REQUIRED: Deal name must be city + zip3xx (no "Location")
    const dealname = redacted;
    const amount = String(pricing.price);

    // Patch deal: amount + dealname + optional metadata
    const patched = await patchDealSafe(deal_id, {
      dealname,
      amount,
      lead_id: lead_id || String(dealRead.json?.properties?.lead_id || "").trim() || "",
      redacted_location: redacted,
      lead_price: pricing.price,
      lead_tier: pricing.tier,
      lead_status: "Deliverables Processing",
      listing_status: "Unpaid",
    });

    if (!patched.ok) {
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "Deal update failed",
          deal_id,
          detail: patched.text,
          attempted: { dealname, amount, redacted, tier: pricing.tier, price: pricing.price }
        }),
      };
    }

    // Ensure a line item exists & is associated
    const assocTypeId = await getLineItemDealAssocTypeId();
    const existingLineItems = await listDealLineItems(deal_id);

    let lineItemId = existingLineItems[0] || "";

    const lineItemName = `Security Lead — ${redacted}`;
    const sku = lead_id ? `HSC-${lead_id}` : `HSC-${deal_id}`;

    if (lineItemId) {
      // Update existing
      const upd = await hsPatch(`/crm/v3/objects/line_items/${encodeURIComponent(lineItemId)}`, {
        properties: {
          name: lineItemName,
          quantity: "1",
          price: String(pricing.price),
          hs_sku: sku,
          hs_line_item_currency_code: DEFAULT_CURRENCY,
        }
      });
      if (!upd.ok) lineItemId = "";
    }

    if (!lineItemId) {
      const created = await createLineItem({
        name: lineItemName,
        quantity: "1",
        price: String(pricing.price),
        hs_sku: sku,
        hs_line_item_currency_code: DEFAULT_CURRENCY,
      });

      if (!created.ok || !created.json?.id) {
        return {
          statusCode: 500,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({ error: "Line item create failed", deal_id, detail: created.text, pricing }),
        };
      }

      lineItemId = String(created.json.id);

      const assoc = await associateLineItemToDeal(lineItemId, deal_id, assocTypeId);
      if (!assoc.ok) {
        return {
          statusCode: 500,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({
            error: "Line item association failed",
            deal_id,
            line_item_id: lineItemId,
            detail: assoc.text,
            assocTypeId
          }),
        };
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        deal_id,
        lead_id: lead_id || String(dealRead.json?.properties?.lead_id || "").trim(),
        line_item_id: lineItemId,
        amount: pricing.price,
        lead_tier: pricing.tier,
        redacted_location: redacted,
        pricing_components: pricing.components,
      }),
    };
  } catch (err) {
    console.error("ensure-line-item error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
