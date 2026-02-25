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

  function safeNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  async function listDealLineItems(dealId) {
    // HubSpot v3 associations list
    return hsGet(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items?limit=100`);
  }

  async function associateDealToLineItem(dealId, lineItemId) {
    // HubSpot v3 association create
    return hsPut(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items/${encodeURIComponent(lineItemId)}/deal_to_line_item`);
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const deal_id = String(body.deal_id || "").trim();
    const lead_id = String(body.lead_id || "").trim();
    const payload = (body.payload && typeof body.payload === "object") ? body.payload : {};

    if (!deal_id) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id" }) };
    }

    // 1) If line item already associated, return it
    const assoc = await listDealLineItems(deal_id);
    const existingIds =
      (assoc.ok && assoc.json && Array.isArray(assoc.json.results))
        ? assoc.json.results.map(r => String(r.id || "").trim()).filter(Boolean)
        : [];

    if (existingIds.length) {
      return {
        statusCode: 200,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ ok: true, deal_id, line_item_id: existingIds[0], already_existed: true, all_line_item_ids: existingIds }),
      };
    }

    // 2) Create a line item
    const redacted = buildRedactedLocation(payload) || "Location";
    const name = `Home Secure Lead — ${redacted}`;

    // Choose a simple price: prefer payload.lead_price, else upfront, else 0
    const price = safeNumber(payload.lead_price ?? payload.price ?? payload.hsc_upfront ?? payload.upfront ?? 0);

    const created = await hsPost("/crm/v3/objects/line_items", {
      properties: {
        name,
        quantity: "1",
        price: String(price),
        // description is a standard property in many portals; if yours doesn't have it, HubSpot will reject ONLY if property doesn't exist.
        // If you want to be ultra-safe, remove "description".
        description: lead_id ? `Lead ID: ${lead_id}` : `Deal ID: ${deal_id}`,
      }
    });

    if (!created.ok || !created.json?.id) {
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Line item create failed", detail: created.text, status: created.status }),
      };
    }

    const lineItemId = String(created.json.id).trim();

    // 3) Associate it to the deal
    const linked = await associateDealToLineItem(deal_id, lineItemId);
    if (!linked.ok) {
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Line item association failed", deal_id, line_item_id: lineItemId, detail: linked.text, status: linked.status }),
      };
    }

    // 4) Optional: update dealname + listing_status if those properties exist (ignore errors)
    // NOTE: If properties don't exist, this patch will return validation error. We ignore it.
    const patch = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(deal_id)}`, {
      properties: {
        dealname: name,
        listing_status: "Unpaid",
        line_item_id: lineItemId,
      }
    });

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        deal_id,
        line_item_id: lineItemId,
        already_existed: false,
        deal_patch_ok: patch.ok,
        deal_patch_status: patch.status,
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
