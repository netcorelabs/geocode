// netlify/functions/hubspot-sync.js
import crypto from "node:crypto";

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

  // Account #2: Deals/Line Items (Private App)
  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
  }

  // Account #1: Contacts (Form Submit)
  const HSC_PORTAL_ID = String(process.env.HSC_PORTAL_ID || "").trim();
  const HSC_FORM_ID   = String(process.env.HSC_FORM_ID || "").trim();

  const HS_HEADERS = { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" };

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  async function hsGet(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: { Authorization: `Bearer ${HS_TOKEN}` } });
  }
  async function hsPost(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "POST", headers: HS_HEADERS, body: JSON.stringify(body) });
  }
  async function hsPatch(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "PATCH", headers: HS_HEADERS, body: JSON.stringify(body) });
  }

  function norm(s){ return String(s || "").replace(/\s+/g, " ").trim(); }
  function safeZip3(zip){
    const m = String(zip || "").match(/\b(\d{3})\d{2}(?:-\d{4})?\b/);
    return m ? m[1] : "";
  }
  function parseCityStateZip(formatted){
    const s = String(formatted || "");
    const m = s.match(/,\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})(?:-\d{4})?/);
    if(!m) return null;
    return { city: m[1].trim(), state: m[2].trim(), zip: m[3].trim() };
  }

  async function dealPropertyExists(name){
    const r = await hsGet(`/crm/v3/properties/deals/${encodeURIComponent(name)}`);
    return r.ok;
  }

  async function findDealByLeadId(leadId){
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id", "deliverable_pdf_file_id", "deliverable_csv_file_id"],
      limit: 1,
    });
    return r.ok && r.json?.results?.[0] ? r.json.results[0] : null;
  }

  async function getLineItemAssociations(dealId){
    const r = await hsGet(`/crm/v3/objects/deals/${dealId}/associations/line_items`);
    return (r.json?.results || []).map(x => x.id).filter(Boolean);
  }

  async function createLineItemForDeal({ dealId, leadId, price, name, description }){
    // assocTypeId 20 = line item -> deal
    const r = await hsPost("/crm/v3/objects/line_items", {
      properties: {
        name,
        description,
        quantity: 1,
        price: price,
        hs_sku: `LEAD-${leadId}`,
      },
      associations: [
        { to: { id: Number(dealId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 20 }] },
      ],
    });
    return r.ok ? r.json?.id : null;
  }

  async function resolvePipelineAndStage(){
    const wantPipeline = String(process.env.HUBSPOT_DEAL_PIPELINE_ID || "").trim();
    const wantStage    = String(process.env.HUBSPOT_DEAL_STAGE_QUALIFIED || "").trim();

    const r = await hsGet("/crm/v3/pipelines/deals");
    if(!r.ok || !Array.isArray(r.json?.results) || !r.json.results.length){
      return { pipelineId: wantPipeline || "default", stageId: wantStage || "appointmentscheduled" };
    }

    const pipes = r.json.results;
    let pipe = wantPipeline ? pipes.find(p => String(p.id) === wantPipeline) : null;
    if(!pipe) pipe = pipes[0];

    const stages = Array.isArray(pipe.stages) ? pipe.stages : [];
    let stage = wantStage ? stages.find(s => String(s.id) === wantStage) : null;
    if(!stage) stage = stages[0] || null;

    return { pipelineId: String(pipe.id), stageId: stage ? String(stage.id) : (wantStage || "") };
  }

  async function submitContactToForm(payload, lead_id){
    // If not configured, skip (don’t block Deal)
    if(!HSC_PORTAL_ID || !HSC_FORM_ID) return { ok:false, skipped:true, error:"Missing HSC_PORTAL_ID/HSC_FORM_ID" };

    const url = `https://api.hsforms.com/submissions/v3/integration/submit/${encodeURIComponent(HSC_PORTAL_ID)}/${encodeURIComponent(HSC_FORM_ID)}`;

    const fields = [
      { name: "email", value: norm(payload.email) },
      { name: "firstname", value: norm(payload.firstname) },
      { name: "lastname", value: norm(payload.lastname) },
      { name: "phone", value: norm(payload.phone) },

      // HubSpot address format
      { name: "address", value: norm(payload.street_address || "") },
      { name: "city", value: norm(payload.city || "") },
      { name: "state", value: norm(payload.state_code || payload.state || "") },
      { name: "zip", value: norm(payload.postal_code || payload.zip || "") },

      // hidden fields (HubSpot ignores if not on the form)
      { name: "lead_id", value: lead_id },
      { name: "hsc_property_address", value: norm(payload.hsc_property_address || payload.address || "") },
      { name: "hsc_risk_score", value: String(payload.hsc_risk_score ?? "") },
      { name: "hsc_devices", value: norm(payload.hsc_devices || payload.deviceSummary || payload.selectedItems || "") },
      { name: "hsc_monthly", value: String(payload.hsc_monthly ?? payload.monthly ?? "") },
      { name: "hsc_upfront", value: String(payload.hsc_upfront ?? payload.upfront ?? "") },
      { name: "home_ownership", value: norm(payload.home_ownership || "") },
      { name: "time_line", value: norm(payload.time_line || "") },
    ].filter(f => f.value !== "");

    const body = {
      fields,
      context: { pageUri: event.headers?.referer || "", pageName: "HSRESULTS" },
    };

    const r = await fetchJson(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    return { ok:r.ok, status:r.status, text:r.text };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const payload = body.payload || {};
    const risk = body.risk || null;

    const email = norm(payload.email);
    if(!email){
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing payload.email" }) };
    }

    // stable lead_id
    const lead_id = norm(payload.lead_id) || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

    // compute redacted_location
    let city = norm(payload.city);
    let state = norm(payload.state_code || payload.state);
    let zip = norm(payload.postal_code || payload.zip);

    if((!city || !state || !zip) && payload.hsc_property_address){
      const p = parseCityStateZip(payload.hsc_property_address);
      if(p){ city = city || p.city; state = state || p.state; zip = zip || p.zip; }
    }

    const z3 = safeZip3(zip);
    const redacted_location = (city && state ? `${city}, ${state}` : "Location Unknown") + (z3 ? ` ${z3}xx` : "");

    // ✅ Contact goes through Form submit (Account #1)
    const contact_submit = await submitContactToForm(payload, lead_id);

    // ✅ Require Deal property lead_id to exist in Account #2
    const leadIdPropOk = await dealPropertyExists("lead_id");
    if(!leadIdPropOk){
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "Missing Deal property: lead_id",
          fix: "Create a custom Deal property with internal name 'lead_id' in the HubSpot portal tied to HUBSPOT_PRIVATE_APP_TOKEN.",
        }),
      };
    }

    const { pipelineId, stageId } = await resolvePipelineAndStage();

    // Minimal deal props (avoid unknown-property rejections)
    const amount = String(Math.round(Number(payload.lead_price || payload.price || 150)) || 150);

    // Create with placeholder name; then patch with deal_id
    const placeholderName = `Security Lead — ${redacted_location} — PENDING`;

    const dealProps = {
      dealname: placeholderName,
      pipeline: pipelineId,
      dealstage: stageId,
      amount,
      lead_id,
      redacted_location,
    };

    // Find or create deal
    const existingDeal = await findDealByLeadId(lead_id);
    let dealId = existingDeal?.id || null;

    if(!dealId){
      const created = await hsPost("/crm/v3/objects/deals", { properties: dealProps });
      if(!created.ok || !created.json?.id){
        return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error:"Deal create failed", detail: created.text }) };
      }
      dealId = created.json.id;
    } else {
      const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: dealProps });
      if(!patched.ok){
        return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error:"Deal update failed", detail: patched.text }) };
      }
    }

    // ✅ Final deal name uses deal_id
    const finalDealName = `Security Lead — ${redacted_location} — ${dealId}`;
    await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: { dealname: finalDealName } });

    // Line item once
    let lineItemId = null;
    const existingLineItems = await getLineItemAssociations(dealId);
    if(existingLineItems.length) {
      lineItemId = existingLineItems[0];
    } else {
      lineItemId = await createLineItemForDeal({
        dealId,
        leadId: lead_id,
        price: Number(amount),
        name: `Exclusive Lead — ${redacted_location} — ${dealId}`,
        description: `Redacted listing: ${redacted_location} | Deal: ${dealId}`,
      });
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        lead_id,
        deal_id: dealId,
        dealname: finalDealName,
        line_item_id: lineItemId,
        contact_submit,
      }),
    };
  } catch (err) {
    console.error("hubspot-sync error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
