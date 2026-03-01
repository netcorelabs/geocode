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

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Method Not Allowed" }) };

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { ok: res.ok, status: res.status, json };
  }

  async function getDeal(dealId) {
    const r = await fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { headers: hsAuth });
    return r.ok ? r.json : null;
  }

  async function getAssociationTypeId() {
    const r = await fetchJson("https://api.hubapi.com/crm/v4/associations/deals/line_items/labels", { headers: hsAuth });
    if (r.ok && r.json?.results?.length) {
      const pick = r.json.results.find(x => x.associationCategory === "HUBSPOT_DEFINED") || r.json.results[0];
      return pick?.associationTypeId;
    }
    // Fallback: HubSpot default, usually works
    return 20;
  }

  async function listDealLineItems(dealId) {
    const r = await fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items?limit=10`, { headers: hsAuth });
    return r.ok ? (r.json.results || []).map(x => x.id) : [];
  }

  async function createLineItem(name, price, currency) {
    const props = { name, price: String(price), quantity: "1", hs_currency: currency || "USD" };
    const r = await fetchJson("https://api.hubapi.com/crm/v3/objects/line_items", {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });
    if (!r.ok || !r.json?.id) throw new Error(`Create line item failed: ${JSON.stringify(r.json)}`);
    return r.json.id;
  }

  async function associateLineItem(dealId, lineItemId, associationTypeId) {
    const url = `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items/${encodeURIComponent(lineItemId)}/${encodeURIComponent(String(associationTypeId))}`;
    const r = await fetchJson(url, { method: "PUT", headers: hsAuth });
    if (!r.ok) throw new Error(`Associate deal->line_item failed: ${JSON.stringify(r.json)}`);
    return true;
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const dealId = String(body.deal_id || "").trim();
    const leadId = String(body.lead_id || "").trim();
    const lineItemName = String(body.line_item_name || `Home Secure Lead ${Date.now()}`);
    const leadPrice = Number(body.lead_price || 0);
    const currency = String(body.currency || "USD");

    if (!dealId || !leadId) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id or lead_id" }) };

    // Confirm deal exists
    const deal = await getDeal(dealId);
    if (!deal) return { statusCode: 404, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: `Deal not found: ${dealId}` }) };

    // Determine associationTypeId
    const associationTypeId = await getAssociationTypeId();
    if (!associationTypeId) return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "No associationTypeId found in HubSpot" }) };

    // List line items already associated
    let lineItems = await listDealLineItems(dealId);
    let lineItemId = lineItems[0];

    // Create if none
    if (!lineItemId) {
      lineItemId = await createLineItem(lineItemName, leadPrice, currency);
      await associateLineItem(dealId, lineItemId, associationTypeId);
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ ok: true, deal_id: dealId, lead_id: leadId, line_item_id: lineItemId, associationTypeId })
    };

  } catch (err) {
    console.error("ensure-line-item error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "ensure-line-item failed", detail: String(err?.message || err) })
    };
  }
}
