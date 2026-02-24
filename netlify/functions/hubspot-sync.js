// netlify/functions/hubspot-sync.js
import crypto from "node:crypto";

export async function handler(event) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method not allowed" }) };

  // Account #2 (Deals) — Private App token
  const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";
  if (!HS_TOKEN) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };

  // Account #1 (Contacts) — HubSpot Form submit
  const HSC_PORTAL_ID = String(process.env.HSC_PORTAL_ID || "").trim();
  const HSC_FORM_ID   = String(process.env.HSC_FORM_ID || "").trim();

  const HS_HEADERS = { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" };

  async function readText(r){ try { return await r.text(); } catch { return ""; } }
  async function fetchJson(url, options){
    const r = await fetch(url, options);
    const t = await readText(r);
    let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = null; }
    return { ok:r.ok, status:r.status, json:j, text:t };
  }

  async function hsGet(path){
    return fetchJson(`https://api.hubapi.com${path}`, { method:"GET", headers:{ Authorization:`Bearer ${HS_TOKEN}` } });
  }
  async function hsPost(path, body){
    return fetchJson(`https://api.hubapi.com${path}`, { method:"POST", headers: HS_HEADERS, body: JSON.stringify(body) });
  }
  async function hsPatch(path, body){
    return fetchJson(`https://api.hubapi.com${path}`, { method:"PATCH", headers: HS_HEADERS, body: JSON.stringify(body) });
  }

  function norm(s){ return String(s||"").replace(/\s+/g," ").trim(); }
  function zip3(zip){
    const m = String(zip||"").match(/\b(\d{3})\d{2}(?:-\d{4})?\b/);
    return m ? m[1] : "";
  }
  function parseCityStateZip(formatted){
    const s = String(formatted||"");
    const m = s.match(/,\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})(?:-\d{4})?/);
    if(!m) return null;
    return { city:m[1].trim(), state:m[2].trim(), zip:m[3].trim() };
  }

  async function resolvePipelineAndStage(){
    // env optional; if invalid, we auto-pick a valid pipeline/stage
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

  async function findDealByLeadId(lead_id){
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: lead_id }] }],
      properties: ["lead_id"],
      limit: 1
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
      properties: { name, description, quantity: 1, price: price, hs_sku: `LEAD-${leadId}` },
      associations: [{ to: { id: Number(dealId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 20 }] }]
    });
    return r.ok ? r.json?.id : null;
  }

  async function submitContactToForm(payload, lead_id){
    // If env vars not set, skip (don’t block deal creation)
    if(!HSC_PORTAL_ID || !HSC_FORM_ID) {
      return { ok:false, skipped:true, error:"Missing HSC_PORTAL_ID/HSC_FORM_ID" };
    }

    const submitUrl = `https://api.hsforms.com/submissions/v3/integration/submit/${encodeURIComponent(HSC_PORTAL_ID)}/${encodeURIComponent(HSC_FORM_ID)}`;

    // Map to common HubSpot form field names
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

      // Your custom fields (must exist on the form as hidden fields)
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
      context: {
        pageUri: event.headers?.referer || "",
        pageName: "HSRESULTS",
      }
    };

    const r = await fetchJson(submitUrl, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });

    // HS forms returns 200/204 depending; treat ok accordingly
    return { ok: r.ok, status: r.status, text: r.text };
  }

  try{
    const body = JSON.parse(event.body || "{}");
    const payload = body.payload || {};
    const risk = body.risk || null;

    const email = norm(payload.email);
    if(!email){
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Missing payload.email" }) };
    }

    const lead_id = norm(payload.lead_id) || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

    // Clean defaults so dealname isn't "— — —"
    const time_line = norm(payload.time_line || payload.timeline || payload.timeLine) || "Researching";
    const home_ownership = norm(payload.home_ownership || payload.homeOwnership || payload.ownership) || "Unknown";

    // Redacted location (city/state/zip3)
    let city = norm(payload.city);
    let state = norm(payload.state_code || payload.state);
    let zip = norm(payload.postal_code || payload.zip);

    if((!city || !state || !zip) && payload.hsc_property_address){
      const p = parseCityStateZip(payload.hsc_property_address);
      if(p){ city = city || p.city; state = state || p.state; zip = zip || p.zip; }
    }

    const z3 = zip3(zip);
    const redacted_location = (city && state ? `${city}, ${state}` : "Location Unknown") + (z3 ? ` ${z3}xx` : "");

    // ✅ submit contact to Account #1 form (does NOT block deal)
    const contactSubmit = await submitContactToForm(payload, lead_id);

    // ✅ Deal + line item in Account #2
    const { pipelineId, stageId } = await resolvePipelineAndStage();
    const dealname = `Security Lead — ${redacted_location} — ${time_line} — ${home_ownership}`;

    // keep properties minimal to avoid HubSpot “unknown property” errors
    // REQUIRE lead_id to exist on Deal properties in Account #2
    const dealProps = {
      dealname,
      pipeline: pipelineId,
      dealstage: stageId,
      amount: String(Math.round(Number(payload.lead_price || payload.price || 150)) || 150),
      lead_id, // must exist in Account #2
    };

    const clientDealId = norm(body.deal_id || "");
    let dealId = null;

    // 1) patch by deal_id if provided (prevents duplicates)
    if(clientDealId){
      const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(clientDealId)}`, { properties: dealProps });
      if(patched.ok) dealId = clientDealId;
    }

    // 2) search by lead_id
    if(!dealId){
      const existing = await findDealByLeadId(lead_id);
      if(existing?.id){
        dealId = existing.id;
        const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: dealProps });
        if(!patched.ok){
          return { statusCode: 500, headers: cors, body: JSON.stringify({ error:"Deal update failed", detail: patched.text }) };
        }
      } else {
        const created = await hsPost("/crm/v3/objects/deals", { properties: dealProps });

        // FAIL LOUD (this fixes your “no deal + no redirect”)
        if(!created.ok || !created.json?.id){
          return {
            statusCode: 500,
            headers: cors,
            body: JSON.stringify({
              error:"Deal create failed",
              detail: created.text,
              pipelineId,
              stageId,
              tried_properties: Object.keys(dealProps),
              note: "Make sure Deal property 'lead_id' exists in Account #2."
            })
          };
        }
        dealId = created.json.id;
      }
    }

    // Line item once
    let lineItemId = null;
    try{
      const existingLis = await getLineItemAssociations(dealId);
      if(existingLis.length) lineItemId = existingLis[0];
      else {
        const price = Math.round(Number(dealProps.amount || 150)) || 150;
        lineItemId = await createLineItemForDeal({
          dealId,
          leadId: lead_id,
          price,
          name: `Exclusive Lead — ${redacted_location} — ${time_line} — ${home_ownership}`,
          description: `Redacted listing: ${redacted_location} | Timeline: ${time_line} | Ownership: ${home_ownership}`
        });
      }
    }catch(e){ lineItemId = null; }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        ok:true,
        lead_id,
        deal_id: dealId,
        line_item_id: lineItemId,
        contact_submit: contactSubmit
      })
    };
  } catch(e){
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e?.message || e) }) };
  }
}
