// netlify/functions/hubspot-sync.js
export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "ok" };

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" };

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: res.ok, status: res.status, json, text };
  }

  async function findDealByEmail(email) {
    const r = await fetchJson("https://api.hubapi.com/crm/v3/objects/deals/search", {
      method: "POST",
      headers: hsAuth,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
        limit: 1
      })
    });
    return r.ok && r.json?.results?.[0]?.id ? String(r.json.results[0].id) : null;
  }

  async function createDeal({ email, lead_id, dealname }) {
    const r = await fetchJson("https://api.hubapi.com/crm/v3/objects/deals", {
      method: "POST",
      headers: hsAuth,
      body: JSON.stringify({ properties: { email, lead_id, dealname } })
    });
    if (!r.ok || !r.json?.id) throw new Error(`Create deal failed (${r.status})`);
    return String(r.json.id);
  }

  async function createLineItem({ name, price, currency }) {
    const props = { name, price: String(Number(price || 0)), quantity: "1", hs_currency: currency || "USD" };
    const r = await fetchJson("https://api.hubapi.com/crm/v3/objects/line_items", {
      method: "POST",
      headers: hsAuth,
      body: JSON.stringify({ properties: props })
    });
    if (!r.ok || !r.json?.id) throw new Error(`Create line item failed (${r.status})`);
    return String(r.json.id);
  }

  async function getAssocTypeId() {
    try {
      const r = await fetchJson("https://api.hubapi.com/crm/v4/associations/deals/line_items/labels", { method: "GET", headers: hsAuth });
      if (r.ok && r.json?.results?.length) {
        const pick = r.json.results.find(x => x.associationCategory === "HUBSPOT_DEFINED") || r.json.results[0];
        if (pick?.associationTypeId) return Number(pick.associationTypeId);
      }
    } catch {}
    return 6; // fallback
  }

  async function associateDealLineItem(dealId, lineItemId, associationTypeId) {
    const url = `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items/${encodeURIComponent(lineItemId)}/${encodeURIComponent(String(associationTypeId))}`;
    const r = await fetchJson(url, { method: "PUT", headers: hsAuth });
    if (!r.ok) throw new Error(`Associate deal→line_item failed (${r.status})`);
    return true;
  }

  async function patchDeal(dealId, properties) {
    const r = await fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      method: "PATCH",
      headers: hsAuth,
      body: JSON.stringify({ properties })
    });
    if (!r.ok) throw new Error(`Patch deal failed (${r.status})`);
    return r.json;
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const email = String(body.email || "").trim();
    if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing email" }) };

    const lead_id = String(body.lead_id || Date.now());
    const dealname = body.dealname || `HSC Lead ${lead_id}`;
    const line_item_name = body.line_item_name || `HSC Lead Item ${lead_id}`;
    const lead_price = Number(body.lead_price || 0);
    const currency = body.currency || "USD";

    // 1️⃣ Find or create deal
    let dealId = await findDealByEmail(email);
    if (!dealId) dealId = await createDeal({ email, lead_id, dealname });

    // 2️⃣ Create line item
    const lineItemId = await createLineItem({ name: line_item_name, price: lead_price, currency });

    // 3️⃣ Get association type
    const assocTypeId = await getAssocTypeId();

    // 4️⃣ Associate line item to deal
    await associateDealLineItem(dealId, lineItemId, assocTypeId);

    // 5️⃣ Update deal amount, status
    await patchDeal(dealId, { amount: String(Math.round(lead_price)), lead_status: "Deliverables Processing", dealname });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, deal_id: dealId, line_item_id: lineItemId, associationTypeId: assocTypeId }) };
  } catch (err) {
    console.error("hubspot-sync error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
}
