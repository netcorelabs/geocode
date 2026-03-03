// netlify/functions/hubspot-sync.js
export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "https://www.netcoreleads.com",
    "https://netcoreleads.com",
    "https://api.netcoreleads.com",
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

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" };

  async function readText(res){ try{ return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: res.ok, status: res.status, json, text };
  }

  async function hsGet(path){
    return fetchJson(`https://api.hubapi.com${path}`, { method:"GET", headers: hsAuth });
  }
  async function hsPost(path, body){
    return fetchJson(`https://api.hubapi.com${path}`, { method:"POST", headers: hsAuth, body: JSON.stringify(body) });
  }
  async function hsPatch(path, body){
    return fetchJson(`https://api.hubapi.com${path}`, { method:"PATCH", headers: hsAuth, body: JSON.stringify(body) });
  }

  async function patchDealWithFallback(dealId, properties){
    const attempt = async (props) =>
      hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: props });

    let r = await attempt(properties);
    if (r.ok) return r;

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

  async function findContactIdByEmail(email){
    const r = await hsPost("/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email"],
      limit: 1
    });
    return (r.ok && r.json?.results?.[0]?.id) ? String(r.json.results[0].id) : "";
  }

  async function findDealByLeadId(lead_id){
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: lead_id }] }],
      properties: ["lead_id", "dealname", "amount", "lead_status"],
      limit: 1
    });
    return (r.ok && r.json?.results?.[0]?.id) ? String(r.json.results[0].id) : "";
  }

  async function getExistingLineItemFromDeal(dealId){
    const r = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items?limit=5`);
    const first = r.json?.results?.[0]?.id;
    return first ? String(first) : "";
  }

  async function createDeal({ lead_id, dealname, amount }){
    const r = await fetchJson("https://api.hubapi.com/crm/v3/objects/deals", {
      method: "POST",
      headers: hsAuth,
      body: JSON.stringify({ properties: { lead_id, dealname, amount: String(amount || 0) } })
    });
    if (!r.ok || !r.json?.id) throw new Error(`Create deal failed (${r.status}): ${r.text}`);
    return String(r.json.id);
  }

  async function createLineItem({ name, price, currency }){
    const props = {
      name,
      price: String(Number(price || 0)),
      quantity: "1",
      hs_currency: currency || "USD"
    };
    const r = await fetchJson("https://api.hubapi.com/crm/v3/objects/line_items", {
      method: "POST",
      headers: hsAuth,
      body: JSON.stringify({ properties: props })
    });
    if (!r.ok || !r.json?.id) throw new Error(`Create line item failed (${r.status}): ${r.text}`);
    return String(r.json.id);
  }

  async function getDealLineItemAssocTypeId(){
    const r = await fetchJson("https://api.hubapi.com/crm/v4/associations/deals/line_items/labels", { method:"GET", headers: hsAuth });
    if (r.ok && r.json?.results?.length){
      const pick = r.json.results.find(x => x.associationCategory === "HUBSPOT_DEFINED") || r.json.results[0];
      if (pick?.associationTypeId) return Number(pick.associationTypeId);
    }
    return 6; // HubSpot default “deal to line item” is often 6
  }

  async function associateDealLineItem(dealId, lineItemId, associationTypeId){
    const url = `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items/${encodeURIComponent(lineItemId)}/${encodeURIComponent(String(associationTypeId))}`;
    const r = await fetchJson(url, { method:"PUT", headers: hsAuth });
    if (!r.ok) throw new Error(`Associate deal→line_item failed (${r.status}): ${r.text}`);
    return true;
  }

  async function associateDealToContact(dealId, contactId){
    // HubSpot-defined association type for deal->contact is usually 3, but we’ll use the v4 labels endpoint if available
    let assocTypeId = 3;
    try{
      const r = await fetchJson("https://api.hubapi.com/crm/v4/associations/deals/contacts/labels", { method:"GET", headers: hsAuth });
      if (r.ok && r.json?.results?.length){
        const pick = r.json.results.find(x => x.associationCategory === "HUBSPOT_DEFINED") || r.json.results[0];
        if (pick?.associationTypeId) assocTypeId = Number(pick.associationTypeId);
      }
    } catch {}

    const url = `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/contacts/${encodeURIComponent(contactId)}/${encodeURIComponent(String(assocTypeId))}`;
    const r = await fetchJson(url, { method:"PUT", headers: hsAuth });
    // If it fails we don’t hard-fail the flow
    return r.ok;
  }

  try{
    const body = JSON.parse(event.body || "{}");
    const email = String(body.email || "").trim();
    const lead_id = String(body.lead_id || "").trim() || String(Date.now());
    const dealname = String(body.dealname || `HSC Lead ${lead_id}`);
    const line_item_name = String(body.line_item_name || `HSC Lead Item ${lead_id}`);
    const lead_price = Number(body.lead_price || 0);
    const currency = String(body.currency || "USD");

    if (!email) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing email" }) };
    }

    // 1) Find existing deal by lead_id (idempotent)
    let dealId = await findDealByLeadId(lead_id);

    // 2) Create deal if not exists
    if (!dealId) {
      dealId = await createDeal({ lead_id, dealname, amount: Math.round(lead_price) });
    } else {
      // keep name/amount updated without crashing on missing properties
      await patchDealWithFallback(dealId, { dealname, amount: String(Math.round(lead_price)) });
    }

    // 3) Associate deal to contact by email (best effort)
    const contactId = await findContactIdByEmail(email);
    if (contactId) await associateDealToContact(dealId, contactId);

    // 4) Reuse line item if already associated; otherwise create and associate
    let lineItemId = await getExistingLineItemFromDeal(dealId);
    if (!lineItemId) {
      lineItemId = await createLineItem({ name: line_item_name, price: lead_price, currency });
      const assocTypeId = await getDealLineItemAssocTypeId();
      await associateDealLineItem(dealId, lineItemId, assocTypeId);
    }

    // 5) Update lead_status if that property exists (won’t crash if not)
    await patchDealWithFallback(dealId, { lead_status: "Deliverables Processing" });

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ ok: true, deal_id: dealId, line_item_id: lineItemId })
    };

  } catch(err){
    console.error("hubspot-sync error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
