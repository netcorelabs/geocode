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
    const origin = String(originRaw || "").trim();
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
  }
  const HS = {
    get:  (path) => fetchJson(`https://api.hubapi.com${path}`, { method:"GET", headers: hsHeaders }),
    post: (path, body) => fetchJson(`https://api.hubapi.com${path}`, { method:"POST", headers: hsHeaders, body: JSON.stringify(body) }),
    put:  (path) => fetchJson(`https://api.hubapi.com${path}`, { method:"PUT", headers: hsHeaders }),
    patch:(path, body) => fetchJson(`https://api.hubapi.com${path}`, { method:"PATCH", headers: hsHeaders, body: JSON.stringify(body) }),
  };

  const asStr = (v)=>String(v ?? "").trim();
  const asNum = (v, d=0)=>{ const n = Number(v); return Number.isFinite(n) ? n : d; };

  // Patch with fallback: drop unknown properties rather than failing
  async function patchDealWithFallback(dealId, properties){
    const attempt = async (props)=>HS.patch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: props });

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
    const r = await HS.post("/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName:"email", operator:"EQ", value: email }] }],
      properties: ["email"],
      limit: 1
    });
    return (r.ok && r.json?.results?.[0]?.id) ? String(r.json.results[0].id) : "";
  }

  async function getAssocTypeId(from, to){
    const r = await fetchJson(`https://api.hubapi.com/crm/v4/associations/${encodeURIComponent(from)}/${encodeURIComponent(to)}/labels`, {
      method:"GET",
      headers: { Authorization: `Bearer ${HS_TOKEN}` }
    });
    if (r.ok && Array.isArray(r.json?.results) && r.json.results.length){
      const pick = r.json.results.find(x => x.associationCategory === "HUBSPOT_DEFINED") || r.json.results[0];
      if (pick?.associationTypeId) return Number(pick.associationTypeId);
    }
    return null;
  }

  async function assocV4Batch(fromType, toType, fromId, toId, assocTypeId){
    const url = `https://api.hubapi.com/crm/v4/objects/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/batch/create`;
    const input = { from: { id: String(fromId) }, to: { id: String(toId) } };
    if (assocTypeId) input.type = Number(assocTypeId);

    const r = await fetchJson(url, {
      method:"POST",
      headers: hsHeaders,
      body: JSON.stringify({ inputs: [input] })
    });
    return r.ok;
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
  }

  async function createDealSafe(props){
    // Try with full property set; if some properties don't exist, patch fallback logic later.
    const r = await HS.post("/crm/v3/objects/deals", { properties: props });
    if (r.ok && r.json?.id) return String(r.json.id);

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
  }

  try{
    const body = JSON.parse(event.body || "{}");

    // Inputs you can send from landing:
    const email = asStr(body.email);
    const zipcode = asStr(body.zip || body.zipcode || body.postal_code || body.postalCode);
    const lead_id = asStr(body.lead_id) || (globalThis.crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()));
    const contact_id_in = asStr(body.contact_id || body.contactId);

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

    const dealId = await createDealSafe(dealProps);

    // Best-effort patch to add optional custom fields if they exist
    await patchDealWithFallback(dealId, {
      lead_id,
      lead_zip: zipcode,
      lead_contact_id: contactId,
      lead_status: "SQL Lead Interest"
    });

    // Associate deal ↔ contact (best effort)
    if (contactId) {
      const assocTypeId = await getAssocTypeId("deals", "contacts");
      if (assocTypeId) await assocV4Batch("deals", "contacts", dealId, contactId, assocTypeId);
    }

    // Optional inventory push
    await pushToLeadStoreBestEffort({
      lead_id,
      deal_id: dealId,
      email,
      zip: zipcode,
      contact_id: contactId,
      amount
    });

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        lead_id,
        deal_id: dealId,
        contact_id: contactId || null,
        dealname: dealName,
        amount
      })
    };

  } catch(err){
    console.error("hubspot-sync error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: String(err?.message || err) })
    };
  }
}
