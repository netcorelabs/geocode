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

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: res.ok, status: res.status, json, text };
  }

  async function patchWithFallback(objectType, objectId, properties) {
    const attempt = async (props) =>
      fetchJson(`https://api.hubapi.com/crm/v3/objects/${objectType}/${encodeURIComponent(objectId)}`, {
        method: "PATCH",
        headers: { ...hsAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: props }),
      });

    let r = await attempt(properties);
    if (r.ok) return r;

    // Strip unknown properties and retry
    const badProps = new Set(
      (r.json?.errors || [])
        .filter(e => e.code === "PROPERTY_DOESNT_EXIST")
        .flatMap(e => e.context?.propertyName || [])
    );

    if (badProps.size) {
      const filtered = Object.fromEntries(Object.entries(properties).filter(([k]) => !badProps.has(k)));
      if (Object.keys(filtered).length) {
        r = await attempt(filtered);
        if (r.ok) return r;
      }
    }
    return r;
  }

  async function readDeal(dealId) {
    const r = await fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=dealname,amount,lead_id,hs_object_id`, {
      method: "GET", headers: { ...hsAuth }
    });
    return r.ok ? r.json : null;
  }

  async function createLineItem({ name, price, currency }) {
    const props = {
      name: String(name || "Home Secure Lead"),
      price: String(Number(price || 0)),
      quantity: "1",
      hs_currency: String(currency || "USD"),
    };
    const r = await fetchJson("https://api.hubapi.com/crm/v3/objects/line_items", {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });
    if (!r.ok || !r.json?.id) throw new Error(`Create line item failed (${r.status})`);
    return String(r.json.id);
  }

  async function updateLineItem(lineItemId, { name, price, currency }) {
    const props = {
      name: String(name || "Home Secure Lead"),
      price: String(Number(price || 0)),
      quantity: "1",
      hs_currency: String(currency || "USD"),
    };
    const r = await patchWithFallback("line_items", lineItemId, props);
    if (!r.ok) throw new Error(`Update line item failed (${r.status})`);
    return true;
  }

  async function getAssocTypeIdDealsLineItems() {
    const r = await fetchJson("https://api.hubapi.com/crm/v4/associations/deals/line_items/labels", {
      method: "GET", headers: { ...hsAuth },
    });
    if (r.ok && r.json?.results?.length) {
      const pick = r.json.results.find(x => x.associationCategory === "HUBSPOT_DEFINED") || r.json.results[0];
      if (pick?.associationTypeId) return pick.associationTypeId;
    }
    throw new Error("Cannot determine deal->line_item associationTypeId");
  }

  async function associateDealToLineItem(dealId, lineItemId, associationTypeId) {
    const url = `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items/${encodeURIComponent(lineItemId)}/${encodeURIComponent(String(associationTypeId))}`;
    const r = await fetchJson(url, { method: "PUT", headers: { ...hsAuth } });
    if (!r.ok) throw new Error(`Associate deal→line_item failed (${r.status})`);
    return true;
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const deal_id = String(body.deal_id || "").trim();
    const lead_price = Number(body.lead_price || 0);
    const currency = String(body.currency || "USD").trim() || "USD";
    const line_item_name = String(body.line_item_name || "").trim();

    if (!deal_id) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id" }) };
    if (!Number.isFinite(lead_price) || lead_price <= 0) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Invalid lead_price" }) };

    // Confirm deal exists
    const deal = await readDeal(deal_id);
    if (!deal || !deal.id) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal not ready or missing", deal_id }) };

    // Create line item
    const lineItemId = await createLineItem({ name: line_item_name, price: lead_price, currency });

    // Associate dynamically
    const assocTypeId = await getAssocTypeIdDealsLineItems();
    await associateDealToLineItem(deal_id, lineItemId, assocTypeId);

    // Optionally patch deal amount
    await patchWithFallback("deals", deal_id, { amount: String(Math.round(lead_price)), lead_price: String(Math.round(lead_price)) });

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ ok: true, deal_id, line_item_id: lineItemId, associationTypeId: assocTypeId })
    };
  } catch (err) {
    console.error("ensure-line-item error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "ensure-line-item failed", detail: String(err?.message || err) }) };
  }
}
