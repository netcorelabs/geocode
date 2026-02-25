// netlify/functions/ensure-line-item.js
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
    return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
  }

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

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

  function safeNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function clamp(n, min, max) {
    n = Number(n);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }
  function zip3(zip) {
    const m = String(zip || "").match(/\b(\d{3})\d{2}\b/);
    return m ? m[1] : "";
  }

  function buildRedactedLocation(payload) {
    const city = String(payload?.city || "").trim();
    const st = String(payload?.state_code || payload?.state || "").trim();
    const z = String(payload?.postal_code || payload?.zip || "").trim();
    const z3 = zip3(z);
    const base = [city, st].filter(Boolean).join(", ");
    return base + (z3 ? ` ${z3}xx` : "");
  }

  /* =========================================================
     LEAD PRICING (Industry-style: tier + value-based)
     - Risk drives urgency/value (higher risk => higher price)
     - Selection value approximates revenue opportunity
       system_value = upfront + monthly * MONTHS_FOR_VALUE
     - lead_price = (BASE + system_value * VALUE_RATE) * MULT
     - clamp to min/max so prices stay sane
  ========================================================= */
  const PRICING = {
    MONTHS_FOR_VALUE: 12,   // change to 24/36 if you want lifetime value
    VALUE_RATE: 0.02,       // 2% of system_value becomes part of lead price
    MIN_PRICE: 29,
    MAX_PRICE: 349,

    // Risk tiers (0-100). Tweak as you like.
    TIERS: [
      { min: 80, tier: "Elite",    base: 95, mult: 1.45 },
      { min: 65, tier: "Premium",  base: 75, mult: 1.25 },
      { min: 50, tier: "Qualified",base: 55, mult: 1.10 },
      { min: 35, tier: "Standard", base: 35, mult: 1.00 },
      { min: 0,  tier: "Basic",    base: 25, mult: 0.85 },
    ],
  };

  function computeLeadPrice(payload) {
    const riskScore = clamp(
      payload?.hsc_risk_score ?? payload?.risk_score ?? payload?.riskScore ?? payload?.risk?.scoring?.riskScore ?? 50,
      0, 100
    );

    const upfront = safeNumber(payload?.hsc_upfront ?? payload?.upfront ?? 0);
    const monthly = safeNumber(payload?.hsc_monthly ?? payload?.monthly ?? 0);

    const systemValue = upfront + (monthly * PRICING.MONTHS_FOR_VALUE);

    const tier = PRICING.TIERS.find(t => riskScore >= t.min) || PRICING.TIERS[PRICING.TIERS.length - 1];

    const valueComponent = systemValue * PRICING.VALUE_RATE;
    const raw = (tier.base + valueComponent) * tier.mult;

    const leadPrice = Math.round(clamp(raw, PRICING.MIN_PRICE, PRICING.MAX_PRICE));

    return {
      riskScore: Math.round(riskScore),
      upfront,
      monthly,
      systemValue: Math.round(systemValue),
      tier: tier.tier,
      leadPrice,
      debug: { raw, base: tier.base, mult: tier.mult, valueComponent, valueRate: PRICING.VALUE_RATE, months: PRICING.MONTHS_FOR_VALUE }
    };
  }

  async function listDealLineItems(dealId) {
    return hsGet(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items?limit=100`);
  }

  async function associateDealToLineItem(dealId, lineItemId) {
    return hsPut(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items/${encodeURIComponent(lineItemId)}/deal_to_line_item`);
  }

  // Safe patch: if portal rejects unknown properties, we retry with only safe standard ones
  async function safePatchDeal(dealId, properties) {
    const attempt1 = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties });
    if (attempt1.ok) return { ok: true, attempted: properties, used: properties, res: attempt1 };

    // If validation error with missing properties, remove them and retry once
    const missing = new Set();
    const errs = attempt1.json?.errors;
    if (Array.isArray(errs)) {
      for (const e of errs) {
        const pname = e?.context?.propertyName?.[0];
        if (pname) missing.add(String(pname));
      }
    }

    // Always keep these (standard deal properties)
    const SAFE_ALWAYS = new Set(["dealname", "amount"]);

    const filtered = {};
    for (const [k, v] of Object.entries(properties || {})) {
      if (missing.has(k) && !SAFE_ALWAYS.has(k)) continue;
      filtered[k] = v;
    }

    // If nothing changed, return original failure
    const changed = Object.keys(filtered).length !== Object.keys(properties || {}).length;
    if (!changed) return { ok: false, attempted: properties, used: properties, res: attempt1 };

    const attempt2 = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: filtered });
    return { ok: attempt2.ok, attempted: properties, used: filtered, res: attempt2 };
  }

  async function patchLineItem(lineItemId, props) {
    return hsPatch(`/crm/v3/objects/line_items/${encodeURIComponent(lineItemId)}`, { properties: props });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const deal_id = String(body.deal_id || "").trim();
    const lead_id = String(body.lead_id || "").trim();
    const payload = (body.payload && typeof body.payload === "object") ? body.payload : {};

    if (!deal_id) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id" }) };
    }

    // Pricing + naming
    const pricing = computeLeadPrice(payload);
    const redacted = buildRedactedLocation(payload) || "—";
    const dealName = `Home Secure Lead — ${redacted}`;
    const lineItemName = dealName;

    // 1) Check associations
    const assoc = await listDealLineItems(deal_id);
    const existingIds =
      (assoc.ok && assoc.json && Array.isArray(assoc.json.results))
        ? assoc.json.results.map(r => String(r.id || "").trim()).filter(Boolean)
        : [];

    let lineItemId = existingIds[0] || "";

    // 2) Create line item if missing
    if (!lineItemId) {
      const created = await hsPost("/crm/v3/objects/line_items", {
        properties: {
          name: lineItemName,
          quantity: "1",
          price: String(pricing.leadPrice),
          description: lead_id ? `Lead ID: ${lead_id} • Tier: ${pricing.tier} • Risk: ${pricing.riskScore}` : `Deal ID: ${deal_id}`,
        }
      });

      if (!created.ok || !created.json?.id) {
        return {
          statusCode: 500,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({ error: "Line item create failed", detail: created.text, status: created.status }),
        };
      }

      lineItemId = String(created.json.id).trim();

      // Associate it to deal
      const linked = await associateDealToLineItem(deal_id, lineItemId);
      if (!linked.ok) {
        return {
          statusCode: 500,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({ error: "Line item association failed", deal_id, line_item_id: lineItemId, detail: linked.text, status: linked.status }),
        };
      }
    } else {
      // 3) If it exists, update its price/name to match new pricing (keeps totals consistent)
      await patchLineItem(lineItemId, {
        name: lineItemName,
        quantity: "1",
        price: String(pricing.leadPrice),
      });
    }

    // 4) Update deal total to match lead price
    const dealPatchProps = {
      dealname: dealName,
      amount: String(pricing.leadPrice),     // ✅ Deal total matches lead price

      // Optional custom props (create these in HubSpot if you want them visible)
      listing_status: "Unpaid",
      lead_price: String(pricing.leadPrice),
      pricing_tier: String(pricing.tier),
      system_value: String(pricing.systemValue),
      redacted_location: redacted,
      line_item_id: lineItemId,
      lead_id: lead_id || String(payload.lead_id || "").trim(),
    };

    const patched = await safePatchDeal(deal_id, dealPatchProps);

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        deal_id,
        lead_id: lead_id || String(payload.lead_id || "").trim() || null,
        line_item_id: lineItemId,
        already_existed: Boolean(existingIds.length),
        deal_patch_ok: patched.ok,
        deal_patch_used: patched.used,
        pricing,
      }),
    };

  } catch (err) {
    console.error("ensure-line-item error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: String(err?.message || err) }),
    };
  }
}
