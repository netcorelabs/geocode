// netlify/functions/hubspot-sync.js
export async function handler(event) {
  // ----------------------------
  // CORS
  // ----------------------------
const allowedOrigins = [
"https://www.homesecurecalculator.com",
"https://homesecurecalculator.com",
@@ -10,7 +13,9 @@ export async function handler(event) {

function corsHeaders(originRaw) {
const origin = (originRaw || "").trim();
    const allowOrigin = origin ? (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]) : "*";
    const allowOrigin = origin
      ? (allowedOrigins.includes(origin) ? origin : allowedOrigins[0])
      : "*";
return {
"Access-Control-Allow-Origin": allowOrigin,
"Access-Control-Allow-Headers": "Content-Type, Authorization",
@@ -25,37 +30,59 @@ export async function handler(event) {
return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
}
if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Method Not Allowed" }) };
    return {
      statusCode: 405,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
}

  // ----------------------------
  // Auth
  // ----------------------------
const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
if (!HS_TOKEN) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }),
    };
}

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" };
  const hsHeaders = {
    Authorization: `Bearer ${HS_TOKEN}`,
    "Content-Type": "application/json",
  };

  async function readText(res){ try{ return await res.text(); } catch { return ""; } }
  async function readText(res) { try { return await res.text(); } catch { return ""; } }
async function fetchJson(url, options = {}) {
const res = await fetch(url, options);
const text = await readText(res);
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
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
  const HS = {
    get: (path) => fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: hsHeaders }),
    post: (path, body) => fetchJson(`https://api.hubapi.com${path}`, { method: "POST", headers: hsHeaders, body: JSON.stringify(body) }),
    patch: (path, body) => fetchJson(`https://api.hubapi.com${path}`, { method: "PATCH", headers: hsHeaders, body: JSON.stringify(body) }),
    put: (path) => fetchJson(`https://api.hubapi.com${path}`, { method: "PUT", headers: hsHeaders }),
  };

  // ----------------------------
  // Helpers
  // ----------------------------
  function asStr(v) { return String(v ?? "").trim(); }
  function asNum(v, d = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
}

  async function patchDealWithFallback(dealId, properties){
  // Patch with fallback: if property doesn't exist, drop it and retry
  async function patchWithFallback(objectType, objectId, properties) {
const attempt = async (props) =>
      hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: props });
      HS.patch(`/crm/v3/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`, { properties: props });

let r = await attempt(properties);
if (r.ok) return r;
@@ -76,136 +103,198 @@ export async function handler(event) {
return r;
}

  async function findContactIdByEmail(email){
    const r = await hsPost("/crm/v3/objects/contacts/search", {
  async function findContactIdByEmail(email) {
    const r = await HS.post("/crm/v3/objects/contacts/search", {
filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
properties: ["email"],
      limit: 1
      limit: 1,
});
return (r.ok && r.json?.results?.[0]?.id) ? String(r.json.results[0].id) : "";
}

  async function findDealByLeadId(lead_id){
    const r = await hsPost("/crm/v3/objects/deals/search", {
  async function findDealByLeadId(lead_id) {
    const r = await HS.post("/crm/v3/objects/deals/search", {
filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: lead_id }] }],
      properties: ["lead_id", "dealname", "amount", "lead_status"],
      limit: 1
      properties: ["lead_id", "dealname", "amount"],
      limit: 1,
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
  async function createDeal({ lead_id, dealname, amount }) {
    const r = await HS.post("/crm/v3/objects/deals", {
      properties: {
        lead_id,
        dealname,
        amount: String(Math.round(amount || 0)),
      }
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
  async function createLineItem({ name, price, currency }) {
    // NOTE: Line Items usually expect: name, price, quantity, hs_currency
    const r = await HS.post("/crm/v3/objects/line_items", {
      properties: {
        name,
        price: String(asNum(price, 0)),
        quantity: "1",
        hs_currency: currency || "USD",
      }
});
if (!r.ok || !r.json?.id) throw new Error(`Create line item failed (${r.status}): ${r.text}`);
return String(r.json.id);
}

  async function getDealLineItemAssocTypeId(){
    const r = await fetchJson("https://api.hubapi.com/crm/v4/associations/deals/line_items/labels", { method:"GET", headers: hsAuth });
    if (r.ok && r.json?.results?.length){
  async function getAssociationTypeId(from, to) {
    // Get labels (associationTypeId) from HubSpot
    const r = await fetchJson(`https://api.hubapi.com/crm/v4/associations/${encodeURIComponent(from)}/${encodeURIComponent(to)}/labels`, {
      method: "GET",
      headers: hsHeaders,
    });

    if (r.ok && Array.isArray(r.json?.results) && r.json.results.length) {
      // prefer HUBSPOT_DEFINED
const pick = r.json.results.find(x => x.associationCategory === "HUBSPOT_DEFINED") || r.json.results[0];
if (pick?.associationTypeId) return Number(pick.associationTypeId);
}
    return 6; // HubSpot default “deal to line item” is often 6

    // Unknown fallback — but we'll still attempt batch create with this; if it fails we won't fail the whole sync
    return null;
  }

  async function associateV4Batch(fromType, toType, fromId, toId, associationTypeId) {
    // v4 batch create associations
    // POST /crm/v4/objects/{from}/{to}/batch/create
    const url = `https://api.hubapi.com/crm/v4/objects/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/batch/create`;
    const body = {
      inputs: [
        {
          from: { id: String(fromId) },
          to: { id: String(toId) },
          type: associationTypeId ? Number(associationTypeId) : undefined
        }
      ]
    };

    // If type is undefined, remove it (some accounts reject undefined fields)
    if (!associationTypeId) delete body.inputs[0].type;

    const r = await fetchJson(url, { method: "POST", headers: hsHeaders, body: JSON.stringify(body) });
    return r;
}

  async function associateDealLineItem(dealId, lineItemId, associationTypeId){
    const url = `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items/${encodeURIComponent(lineItemId)}/${encodeURIComponent(String(associationTypeId))}`;
    const r = await fetchJson(url, { method:"PUT", headers: hsAuth });
    if (!r.ok) throw new Error(`Associate deal→line_item failed (${r.status}): ${r.text}`);
    return true;
  async function associateDealToContact(dealId, contactId) {
    // best-effort; don’t fail whole flow
    try {
      const assocTypeId = await getAssociationTypeId("deals", "contacts");
      if (assocTypeId) {
        const r = await associateV4Batch("deals", "contacts", dealId, contactId, assocTypeId);
        return r.ok;
      }
      // fallback to v3 PUT with a commonly-valid typeId (best effort)
      const r2 = await HS.put(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/contacts/${encodeURIComponent(contactId)}/3`);
      return r2.ok;
    } catch {
      return false;
    }
}

  async function associateDealToContact(dealId, contactId){
    // HubSpot-defined association type for deal->contact is usually 3, but we’ll use the v4 labels endpoint if available
    let assocTypeId = 3;
    try{
      const r = await fetchJson("https://api.hubapi.com/crm/v4/associations/deals/contacts/labels", { method:"GET", headers: hsAuth });
      if (r.ok && r.json?.results?.length){
        const pick = r.json.results.find(x => x.associationCategory === "HUBSPOT_DEFINED") || r.json.results[0];
        if (pick?.associationTypeId) assocTypeId = Number(pick.associationTypeId);
  async function associateDealToLineItem(dealId, lineItemId) {
    // This is where you are currently failing. We will try multiple safe strategies and never throw.
    let association_ok = false;
    let association_error = "";

    try {
      const assocTypeId = await getAssociationTypeId("deals", "line_items");
      // 1) Preferred: v4 batch create with correct associationTypeId
      if (assocTypeId) {
        const r = await associateV4Batch("deals", "line_items", dealId, lineItemId, assocTypeId);
        if (r.ok) return { association_ok: true, association_error: "" };
        association_error = `v4 batch assoc failed (${r.status}): ${r.text}`;
}
    } catch {}

    const url = `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/contacts/${encodeURIComponent(contactId)}/${encodeURIComponent(String(assocTypeId))}`;
    const r = await fetchJson(url, { method:"PUT", headers: hsAuth });
    // If it fails we don’t hard-fail the flow
    return r.ok;
      // 2) Fallback: try v3 PUT using assocTypeId if we have it
      if (assocTypeId) {
        const r2 = await HS.put(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items/${encodeURIComponent(lineItemId)}/${encodeURIComponent(String(assocTypeId))}`);
        if (r2.ok) return { association_ok: true, association_error: "" };
        association_error = association_error || `v3 assoc failed (${r2.status}): ${r2.text}`;
      }

      // 3) Final fallback: try v3 PUT with common default 6 (may work in some portals)
      const r3 = await HS.put(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items/${encodeURIComponent(lineItemId)}/6`);
      if (r3.ok) return { association_ok: true, association_error: "" };
      association_error = association_error || `v3 assoc (type 6) failed (${r3.status}): ${r3.text}`;

    } catch (e) {
      association_error = String(e?.message || e);
    }

    return { association_ok, association_error };
}

  try{
  // ----------------------------
  // Main
  // ----------------------------
  try {
const body = JSON.parse(event.body || "{}");
    const email = String(body.email || "").trim();
    const lead_id = String(body.lead_id || "").trim() || String(Date.now());
    const dealname = String(body.dealname || `HSC Lead ${lead_id}`);
    const line_item_name = String(body.line_item_name || `HSC Lead Item ${lead_id}`);
    const lead_price = Number(body.lead_price || 0);
    const currency = String(body.currency || "USD");

    const email = asStr(body.email);
    const lead_id = asStr(body.lead_id) || String(Date.now());
    const dealname = asStr(body.dealname) || `HSC Lead ${lead_id}`;
    const line_item_name = asStr(body.line_item_name) || `HSC Lead Item ${lead_id}`;
    const lead_price = asNum(body.lead_price, 0);
    const currency = asStr(body.currency) || "USD";

if (!email) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing email" }) };
      return {
        statusCode: 400,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Missing email" }),
      };
}

    // 1) Find existing deal by lead_id (idempotent)
    // 1) Deal idempotency by lead_id
let dealId = await findDealByLeadId(lead_id);

    // 2) Create deal if not exists
if (!dealId) {
      dealId = await createDeal({ lead_id, dealname, amount: Math.round(lead_price) });
      dealId = await createDeal({ lead_id, dealname, amount: lead_price });
} else {
      // keep name/amount updated without crashing on missing properties
      await patchDealWithFallback(dealId, { dealname, amount: String(Math.round(lead_price)) });
      // keep it updated, but don't crash if fields don't exist
      await patchWithFallback("deals", dealId, { dealname, amount: String(Math.round(lead_price)) });
}

    // 3) Associate deal to contact by email (best effort)
    // 2) Contact association (best effort)
const contactId = await findContactIdByEmail(email);
if (contactId) await associateDealToContact(dealId, contactId);

    // 4) Reuse line item if already associated; otherwise create and associate
    let lineItemId = await getExistingLineItemFromDeal(dealId);
    if (!lineItemId) {
      lineItemId = await createLineItem({ name: line_item_name, price: lead_price, currency });
      const assocTypeId = await getDealLineItemAssocTypeId();
      await associateDealLineItem(dealId, lineItemId, assocTypeId);
    }
    // 3) Line item creation
    const lineItemId = await createLineItem({ name: line_item_name, price: lead_price, currency });

    // 5) Update lead_status if that property exists (won’t crash if not)
    await patchDealWithFallback(dealId, { lead_status: "Deliverables Processing" });
    // 4) Deal -> line item association (best effort, never fail whole call)
    const assoc = await associateDealToLineItem(dealId, lineItemId);

    // 5) Optional status (won’t crash if property missing)
    await patchWithFallback("deals", dealId, { lead_status: "Deliverables Processing" });

return {
statusCode: 200,
headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ ok: true, deal_id: dealId, line_item_id: lineItemId })
      body: JSON.stringify({
        ok: true,
        deal_id: dealId,
        line_item_id: lineItemId,
        association_ok: !!assoc.association_ok,
        association_error: assoc.association_error || ""
      }),
};

  } catch(err){
  } catch (err) {
console.error("hubspot-sync error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: String(err?.message || err) }),
    };
}
}
