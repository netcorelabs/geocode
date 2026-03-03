// netlify/functions/hubspot-sync.js
// Creates (or reuses) ONE Deal per lead_id, plus ONE Line Item, and associates them.
// Deal naming: "Exclusive Lead - {ZIP} - {contactId} - {lead_id}"
//
// Expected env:
//   HUBSPOT_PRIVATE_APP_TOKEN (required)
//   HUBSPOT_DEAL_PIPELINE_ID (optional)
//   HUBSPOT_DEAL_STAGE_QUALIFIED (optional)
//   HUBSPOT_DEAL_AMOUNT_DEFAULT (optional; default 400)

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
    const origin = String(originRaw || "").trim();
    const origin = (originRaw || "").trim();
const allowOrigin = origin ? (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]) : "*";
return {
"Access-Control-Allow-Origin": allowOrigin,
@@ -29,43 +41,57 @@ export async function handler(event) {
}

const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  const PIPELINE_ID = String(process.env.HUBSPOT_DEAL_PIPELINE_ID || "").trim();
  const STAGE_QUALIFIED = String(process.env.HUBSPOT_DEAL_STAGE_QUALIFIED || "").trim();

if (!HS_TOKEN) {
return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
}

  const hsHeaders = { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" };

  async function readText(r){ try{ return await r.text(); } catch { return ""; } }
  async function fetchJson(url, options){
    const r = await fetch(url, options);
    const t = await readText(r);
    let j=null; try{ j = t ? JSON.parse(t) : null; } catch { j=null; }
    return { ok:r.ok, status:r.status, json:j, text:t };
  const PIPELINE_ID = String(process.env.HUBSPOT_DEAL_PIPELINE_ID || "").trim();
  const STAGE_ID = String(process.env.HUBSPOT_DEAL_STAGE_QUALIFIED || "").trim();
  const AMOUNT_DEFAULT = Number(process.env.HUBSPOT_DEAL_AMOUNT_DEFAULT || 400) || 400;

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
}
  const HS = {
    get:  (path) => fetchJson(`https://api.hubapi.com${path}`, { method:"GET", headers: hsHeaders }),
    post: (path, body) => fetchJson(`https://api.hubapi.com${path}`, { method:"POST", headers: hsHeaders, body: JSON.stringify(body) }),
    put:  (path) => fetchJson(`https://api.hubapi.com${path}`, { method:"PUT", headers: hsHeaders }),
    patch:(path, body) => fetchJson(`https://api.hubapi.com${path}`, { method:"PATCH", headers: hsHeaders, body: JSON.stringify(body) }),
  };

  const asStr = (v)=>String(v ?? "").trim();
  const asNum = (v, d=0)=>{ const n = Number(v); return Number.isFinite(n) ? n : d; };
  async function hsGet(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: { ...hsAuth } });
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
    return fetchJson(`https://api.hubapi.com${path}`, { method: "PUT", headers: { ...hsAuth } });
  }

  // Patch with fallback: drop unknown properties rather than failing
  async function patchDealWithFallback(dealId, properties){
    const attempt = async (props)=>HS.patch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: props });
  async function patchDealWithFallback(dealId, properties) {
    const attempt = async (props) =>
      hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: props });

let r = await attempt(properties);
if (r.ok) return r;

const badProps = new Set(
(r.json?.errors || [])
        .filter(e => e.code === "PROPERTY_DOESNT_EXIST")
        .flatMap(e => e.context?.propertyName || [])
        .filter((e) => e.code === "PROPERTY_DOESNT_EXIST")
        .flatMap((e) => e.context?.propertyName || [])
);

if (badProps.size) {
@@ -78,152 +104,149 @@ export async function handler(event) {
return r;
}

  async function findContactIdByEmail(email){
    const r = await HS.post("/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName:"email", operator:"EQ", value: email }] }],
      properties: ["email"],
      limit: 1
    });
    return (r.ok && r.json?.results?.[0]?.id) ? String(r.json.results[0].id) : "";
  }
  async function upsertContactByEmail(props) {
    const email = String(props.email || "").trim();
    if (!email) throw new Error("Missing email");

  async function getAssocTypeId(from, to){
    const r = await fetchJson(`https://api.hubapi.com/crm/v4/associations/${encodeURIComponent(from)}/${encodeURIComponent(to)}/labels`, {
      method:"GET",
      headers: { Authorization: `Bearer ${HS_TOKEN}` }
    const s = await hsPost("/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email", "firstname", "lastname"],
      limit: 1,
});
    if (r.ok && Array.isArray(r.json?.results) && r.json.results.length){
      const pick = r.json.results.find(x => x.associationCategory === "HUBSPOT_DEFINED") || r.json.results[0];
      if (pick?.associationTypeId) return Number(pick.associationTypeId);

    const existingId = s.ok && s.json?.results?.[0]?.id ? String(s.json.results[0].id) : "";
    if (existingId) {
      await fetchJson(`https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(existingId)}`, {
        method: "PATCH",
        headers: { ...hsAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: props }),
      });
      return existingId;
}
    return null;
  }

  async function assocV4Batch(fromType, toType, fromId, toId, assocTypeId){
    const url = `https://api.hubapi.com/crm/v4/objects/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/batch/create`;
    const input = { from: { id: String(fromId) }, to: { id: String(toId) } };
    if (assocTypeId) input.type = Number(assocTypeId);
    const c = await hsPost("/crm/v3/objects/contacts", { properties: props });
    if (!c.ok || !c.json?.id) throw new Error(`Create contact failed (${c.status}): ${c.text || JSON.stringify(c.json)}`);
    return String(c.json.id);
  }

    const r = await fetchJson(url, {
      method:"POST",
      headers: hsHeaders,
      body: JSON.stringify({ inputs: [input] })
  async function findExistingDealByLeadToken(leadId) {
    if (!leadId) return null;
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [
        { filters: [{ propertyName: "dealname", operator: "CONTAINS_TOKEN", value: leadId }] }
      ],
      properties: ["dealname", "amount", "pipeline", "dealstage"],
      limit: 1,
});
    return r.ok;
    return (r.ok && r.json?.results?.[0]) ? r.json.results[0] : null;
}

  async function ensureDealPropertiesSafe(props){
    // Always include dealname + amount. Pipeline/stage only if env provided.
    const out = {
      dealname: props.dealname,
      amount: String(Math.round(props.amount || 0)),
      lead_status: props.lead_status || "SQL Lead Interest",
      description: props.description || ""
    };
    if (PIPELINE_ID) out.pipeline = PIPELINE_ID;
    if (STAGE_QUALIFIED) out.dealstage = STAGE_QUALIFIED;

    // Best-effort extras (only work if you created these deal properties)
    out.lead_id = props.lead_id;
    out.lead_zip = props.lead_zip;
    out.lead_contact_id = props.lead_contact_id;

    return out;
  async function createDeal(props) {
    const r = await hsPost("/crm/v3/objects/deals", { properties: props });
    if (!r.ok || !r.json?.id) throw new Error(`Create deal failed (${r.status}): ${r.text || JSON.stringify(r.json)}`);
    return String(r.json.id);
}

  async function createDealSafe(props){
    // Try with full property set; if some properties don't exist, patch fallback logic later.
    const r = await HS.post("/crm/v3/objects/deals", { properties: props });
    if (r.ok && r.json?.id) return String(r.json.id);
  async function createLineItem(props) {
    const r = await hsPost("/crm/v3/objects/line_items", { properties: props });
    if (!r.ok || !r.json?.id) throw new Error(`Create line item failed (${r.status}): ${r.text || JSON.stringify(r.json)}`);
    return String(r.json.id);
  }

    // If HubSpot rejects because unknown fields, retry with minimal required fields
    const r2 = await HS.post("/crm/v3/objects/deals", {
      properties: {
        dealname: props.dealname,
        amount: props.amount,
        ...(PIPELINE_ID ? { pipeline: PIPELINE_ID } : {}),
        ...(STAGE_QUALIFIED ? { dealstage: STAGE_QUALIFIED } : {})
      }
    });
    if (r2.ok && r2.json?.id) return String(r2.json.id);

    throw new Error(`Create deal failed (${r2.status || r.status}): ${r2.text || r.text}`);
  }

  // Optional lead store inventory push
  const LEAD_STORE_ENABLE = String(process.env.LEAD_STORE_ENABLE || "").trim().toLowerCase();
  const LEAD_STORE_API_URL = String(process.env.LEAD_STORE_API_URL || "").trim();
  async function pushToLeadStoreBestEffort(payload){
    if (!LEAD_STORE_API_URL) return;
    if (!["1","true","yes","on"].includes(LEAD_STORE_ENABLE)) return;
    try{
      await fetch(LEAD_STORE_API_URL, {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(payload)
      });
    } catch {}
  async function associateDefault(fromType, fromId, toType, toId) {
    // CRM v4 default association (no associationTypeId required)
    const path = `/crm/v4/objects/${encodeURIComponent(fromType)}/${encodeURIComponent(fromId)}` +
                 `/associations/default/${encodeURIComponent(toType)}/${encodeURIComponent(toId)}`;
    const r = await hsPut(path);
    if (!r.ok) throw new Error(`Associate ${fromType}→${toType} failed (${r.status}): ${r.text || JSON.stringify(r.json)}`);
    return true;
}

  try{
  try {
const body = JSON.parse(event.body || "{}");

    // Inputs you can send from landing:
    const email = asStr(body.email);
    const zipcode = asStr(body.zip || body.zipcode || body.postal_code || body.postalCode);
    const lead_id = asStr(body.lead_id) || (globalThis.crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()));
    const contact_id_in = asStr(body.contact_id || body.contactId);

    const email = String(body.email || "").trim();
if (!email) {
return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing email" }) };
}

    const contactId = contact_id_in || await findContactIdByEmail(email);
    const dealName = `Exclusive Lead - ${zipcode || "NOZIP"} - ${contactId || "NOCONTACT"}`;

    const amount = 400; // per your requirement
    const description =
      `Exclusive Lead\n` +
      `lead_id=${lead_id}\n` +
      `email=${email}\n` +
      (zipcode ? `zip=${zipcode}\n` : "") +
      (contactId ? `contact_id=${contactId}\n` : "");

    // Create a NEW deal per lead (no dedupe on email)
    const dealProps = await ensureDealPropertiesSafe({
      dealname: dealName,
      amount,
      lead_id,
      lead_zip: zipcode,
      lead_contact_id: contactId,
      lead_status: "SQL Lead Interest",
      description
    });
    const lead_id = String(body.lead_id || "").trim() || String(Date.now());
    const firstname = String(body.firstname || "").trim();
    const lastname  = String(body.lastname || "").trim();
    const phone     = String(body.phone || "").trim();

    const dealId = await createDealSafe(dealProps);
    const street_address = String(body.street_address || body.address || "").trim();
    const city = String(body.city || "").trim();
    const state_code = String(body.state_code || body.state || "").trim().toUpperCase();
    const postal_code = String(body.postal_code || body.zip || "").trim();
    const country = String(body.country || body.country_region || "USA").trim();

    // Best-effort patch to add optional custom fields if they exist
    await patchDealWithFallback(dealId, {
      lead_id,
      lead_zip: zipcode,
      lead_contact_id: contactId,
      lead_status: "SQL Lead Interest"
    const amount = Number(body.amount || body.lead_price || AMOUNT_DEFAULT) || AMOUNT_DEFAULT;
    const currency = String(body.currency || "USD").trim() || "USD";

    // 1) Upsert contact in HubSpot account #2
    const contactId = await upsertContactByEmail({
      email,
      ...(firstname ? { firstname } : {}),
      ...(lastname ? { lastname } : {}),
      ...(phone ? { phone } : {}),
      ...(street_address ? { address: street_address } : {}),
      ...(city ? { city } : {}),
      ...(state_code ? { state: state_code } : {}),
      ...(postal_code ? { zip: postal_code } : {}),
      ...(country ? { country } : {}),
});

    // Associate deal ↔ contact (best effort)
    if (contactId) {
      const assocTypeId = await getAssocTypeId("deals", "contacts");
      if (assocTypeId) await assocV4Batch("deals", "contacts", dealId, contactId, assocTypeId);
    // 2) Find or create deal (one per lead_id)
    let deal = await findExistingDealByLeadToken(lead_id);
    let dealId = deal?.id ? String(deal.id) : "";

    const dealname = `Exclusive Lead - ${postal_code || "NA"} - ${contactId} - ${lead_id}`;

    if (!dealId) {
      const props = {
        dealname,
        amount: String(amount),
        ...(PIPELINE_ID ? { pipeline: PIPELINE_ID } : {}),
        ...(STAGE_ID ? { dealstage: STAGE_ID } : {}),
      };
      dealId = await createDeal(props);
    } else {
      await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
        properties: {
          dealname,
          amount: String(amount),
          ...(PIPELINE_ID ? { pipeline: PIPELINE_ID } : {}),
          ...(STAGE_ID ? { dealstage: STAGE_ID } : {})
        },
      });
}

    // Optional inventory push
    await pushToLeadStoreBestEffort({
    // 3) Associate deal to contact
    await associateDefault("contacts", contactId, "deals", dealId);

    // 4) Create line item + associate to deal
    const lineItemName = `Exclusive Lead — ${postal_code || "NA"} — ${lead_id}`;
    const lineItemId = await createLineItem({
      name: lineItemName,
      quantity: "1",
      price: String(amount),
      hs_currency: currency,
      recurringbillingfrequency: "one_time",
    });
    await associateDefault("deals", dealId, "line_items", lineItemId);

    // 5) Best-effort patch (won't fail if properties don't exist)
    await patchDealWithFallback(dealId, {
lead_id,
      deal_id: dealId,
      email,
      zip: zipcode,
      contact_id: contactId,
      amount
      hs_lead_id: lead_id,
      lead_status: "Qualified Lead (SQL)",
      description:
        `Lead created/confirmed.\n` +
        `lead_id: ${lead_id}\n` +
        `contact_id: ${contactId}\n` +
        `line_item_id: ${lineItemId}\n` +
        `amount: ${amount} ${currency}\n`,
});

return {
@@ -233,18 +256,19 @@ export async function handler(event) {
ok: true,
lead_id,
deal_id: dealId,
        contact_id: contactId || null,
        dealname: dealName,
        amount
      })
        contact_id: contactId,
        line_item_id: lineItemId,
        dealname,
        amount,
        currency,
      }),
};

  } catch(err){
  } catch (err) {
console.error("hubspot-sync error:", err);
return {
statusCode: 500,
headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: String(err?.message || err) })
      body: JSON.stringify({ error: "hubspot-sync failed", detail: String(err?.message || err) }),
};
}
}
    
