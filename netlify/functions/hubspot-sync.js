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
  if (!HS_TOKEN) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
  }
  if (!HS_TOKEN) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };

  // Account #1 (Contacts) — HubSpot Form submit
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
  async function readText(r){ try { return await r.text(); } catch { return ""; } }
  async function fetchJson(url, options){
    const r = await fetch(url, options);
    const t = await readText(r);
    let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = null; }
    return { ok:r.ok, status:r.status, json:j, text:t };
}

  async function hsPost(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "POST", headers: HS_HEADERS, body: JSON.stringify(body) });
  async function hsGet(path){
    return fetchJson(`https://api.hubapi.com${path}`, { method:"GET", headers:{ Authorization:`Bearer ${HS_TOKEN}` } });
}
  async function hsPatch(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "PATCH", headers: HS_HEADERS, body: JSON.stringify(body) });
  async function hsPost(path, body){
    return fetchJson(`https://api.hubapi.com${path}`, { method:"POST", headers: HS_HEADERS, body: JSON.stringify(body) });
}
  async function hsGet(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: { Authorization: `Bearer ${HS_TOKEN}` } });
  async function hsPatch(path, body){
    return fetchJson(`https://api.hubapi.com${path}`, { method:"PATCH", headers: HS_HEADERS, body: JSON.stringify(body) });
}

  function normalizeSpaces(str) { return String(str || "").replace(/\s+/g, " ").trim(); }
  function safeZip3(zip) {
    const m = String(zip || "").match(/\b(\d{3})\d{2}(?:-\d{4})?\b/);
  function norm(s){ return String(s||"").replace(/\s+/g," ").trim(); }
  function zip3(zip){
    const m = String(zip||"").match(/\b(\d{3})\d{2}(?:-\d{4})?\b/);
return m ? m[1] : "";
}

  function normalizeOwnership(v) {
    const s = normalizeSpaces(v);
    const low = s.toLowerCase();
    if (low.startsWith("own")) return "Owner";
    if (low.startsWith("rent")) return "Renter";
    return s;
  }

  function normalizeTimeline(v) {
    const s = normalizeSpaces(v);
    const low = s.toLowerCase();
    if (low === "asap" || low.includes("a.s.a.p")) return "ASAP";
    if (low.includes("1") && low.includes("week")) return "1 Week";
    if ((low.includes("2") && low.includes("3") && low.includes("week")) || low.includes("2-3")) return "2 - 3 Weeks";
    if (low.includes("30") && (low.includes("day") || low.includes("+"))) return "30 Days +";
    return s;
  function parseCityStateZip(formatted){
    const s = String(formatted||"");
    const m = s.match(/,\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})(?:-\d{4})?/);
    if(!m) return null;
    return { city:m[1].trim(), state:m[2].trim(), zip:m[3].trim() };
}

  function computeLeadPrice(payload, risk) {
    const explicit = Number(payload.lead_price ?? payload.leadPrice ?? payload.price ?? NaN);
    if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);

    const timeLine = normalizeTimeline(payload.time_line);
    const own = normalizeOwnership(payload.home_ownership);
    const riskScore = Number(payload.hsc_risk_score ?? risk?.scoring?.riskScore ?? NaN);

    const base = 85;
    const bump = Number.isFinite(riskScore) ? Math.max(0, Math.min(100, riskScore)) * 1.2 : 40;
  async function resolvePipelineAndStage(){
    // env optional; if invalid, we auto-pick a valid pipeline/stage
    const wantPipeline = String(process.env.HUBSPOT_DEAL_PIPELINE_ID || "").trim();
    const wantStage    = String(process.env.HUBSPOT_DEAL_STAGE_QUALIFIED || "").trim();

    const timelineMult =
      timeLine === "ASAP" ? 1.4 :
      timeLine === "1 Week" ? 1.25 :
      timeLine === "2 - 3 Weeks" ? 1.1 :
      timeLine === "30 Days +" ? 0.9 : 1.0;
    const r = await hsGet("/crm/v3/pipelines/deals");
    if(!r.ok || !Array.isArray(r.json?.results) || !r.json.results.length){
      return { pipelineId: wantPipeline || "default", stageId: wantStage || "appointmentscheduled" };
    }

    const ownerMult = own === "Owner" ? 1.15 : 1.0;
    const pipes = r.json.results;
    let pipe = wantPipeline ? pipes.find(p => String(p.id) === wantPipeline) : null;
    if(!pipe) pipe = pipes[0];

    const raw = (base + bump) * timelineMult * ownerMult;
    const clamped = Math.max(49, Math.min(399, raw));
    return Math.round(clamped / 5) * 5;
  }
    const stages = Array.isArray(pipe.stages) ? pipe.stages : [];
    let stage = wantStage ? stages.find(s => String(s.id) === wantStage) : null;
    if(!stage) stage = stages[0] || null;

  function parseCityStateZipFromFormattedAddress(formatted) {
    // Matches: "..., City, ST 12345" (common Google formatted address pattern)
    const s = String(formatted || "");
    const m = s.match(/,\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})(?:-\d{4})?/);
    if (!m) return null;
    return { city: m[1].trim(), state: m[2].trim(), zip: m[3].trim() };
    return { pipelineId: String(pipe.id), stageId: stage ? String(stage.id) : (wantStage || "") };
}

  async function findDealByLeadId(leadId) {
  async function findDealByLeadId(lead_id){
const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id", "listing_status", "lead_price", "redacted_location", "time_line", "home_ownership"],
      limit: 1,
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: lead_id }] }],
      properties: ["lead_id"],
      limit: 1
});
return r.ok && r.json?.results?.[0] ? r.json.results[0] : null;
}

  async function getLineItemAssociations(dealId) {
  async function getLineItemAssociations(dealId){
const r = await hsGet(`/crm/v3/objects/deals/${dealId}/associations/line_items`);
    return (r.json?.results || []).map((x) => x.id).filter(Boolean);
    return (r.json?.results || []).map(x => x.id).filter(Boolean);
}

  async function createLineItemForDeal({ dealId, leadId, price, description, name }) {
    // associationTypeId 20 = line item -> deal
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
      properties: { name, description, quantity: 1, price: price, hs_sku: `LEAD-${leadId}` },
      associations: [{ to: { id: Number(dealId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 20 }] }]
});
return r.ok ? r.json?.id : null;
}

  // (Optional) Contact upsert helpers (we will SKIP by default)
  async function findContactIdByEmail(email) {
    const r = await hsPost("/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email"],
      limit: 1,
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
    return r.ok && r.json?.results?.[0]?.id ? r.json.results[0].id : null;
  }

  async function upsertContact(email, properties) {
    const id = await findContactIdByEmail(email);
    if (!id) {
      const created = await hsPost("/crm/v3/objects/contacts", { properties });
      return created.ok ? created.json?.id : null;
    }
    await hsPatch(`/crm/v3/objects/contacts/${id}`, { properties });
    return id;
    // HS forms returns 200/204 depending; treat ok accordingly
    return { ok: r.ok, status: r.status, text: r.text };
}

  try {
  try{
const body = JSON.parse(event.body || "{}");
const payload = body.payload || {};
const risk = body.risk || null;

    // ✅ DEFAULT: do NOT create/update Contact from hubspot-sync
    // You can force it on by sending options.skip_contact=false explicitly.
    const skipContact = body?.options?.skip_contact !== false;

    const email = normalizeSpaces(payload.email);
    if (!email) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing payload.email" }) };
    const email = norm(payload.email);
    if(!email){
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Missing payload.email" }) };
}

    const lead_id =
      normalizeSpaces(payload.lead_id) ||
      (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

    // Normalize timeline + ownership with sensible defaults (fixes "— — —")
    const home_ownership =
      normalizeOwnership(payload.home_ownership || payload.homeOwnership || payload.ownership || "") || "Unknown";
    const time_line =
      normalizeTimeline(payload.time_line || payload.timeline || payload.timeLine || "") || "Researching";

    // Redacted location (prefer city/state/zip; fallback parse from formatted address)
    let city = normalizeSpaces(payload.city || "");
    let stateCode = normalizeSpaces(payload.state_code || payload.state || "");
    let zip = normalizeSpaces(payload.postal_code || payload.zip || "");

    if ((!city || !stateCode || !zip) && payload.hsc_property_address) {
      const parsed = parseCityStateZipFromFormattedAddress(payload.hsc_property_address);
      if (parsed) {
        city = city || parsed.city;
        stateCode = stateCode || parsed.state;
        zip = zip || parsed.zip;
      }
    }
    const lead_id = norm(payload.lead_id) || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

    // Clean defaults so dealname isn't "— — —"
    const time_line = norm(payload.time_line || payload.timeline || payload.timeLine) || "Researching";
    const home_ownership = norm(payload.home_ownership || payload.homeOwnership || payload.ownership) || "Unknown";

    // Redacted location (city/state/zip3)
    let city = norm(payload.city);
    let state = norm(payload.state_code || payload.state);
    let zip = norm(payload.postal_code || payload.zip);

    const zip3 = safeZip3(zip);
    const redacted_location_raw = [city, stateCode].filter(Boolean).join(", ");
    const redacted_location = (redacted_location_raw ? redacted_location_raw : "Location Unknown") + (zip3 ? ` ${zip3}xx` : "");

    const lead_price = computeLeadPrice(payload, risk);

    // ✅ CONTACT UPSERT (ONLY if you explicitly want it)
    if (!skipContact) {
      await upsertContact(email, {
        firstname: payload.firstname || "",
        lastname: payload.lastname || "",
        email,
        phone: payload.phone || "",
        address: payload.street_address || payload.address || "",
        city,
        state: stateCode,
        zip,
        home_ownership,
        time_line,
        hsc_property_address: payload.hsc_property_address || payload.address || "",
        hsc_risk_score: payload.hsc_risk_score ?? "",
        hsc_devices: payload.hsc_devices || payload.deviceSummary || payload.selectedItems || "",
        hsc_monthly: payload.hsc_monthly ?? payload.monthly ?? "",
        hsc_upfront: payload.hsc_upfront ?? payload.upfront ?? "",
      });
    if((!city || !state || !zip) && payload.hsc_property_address){
      const p = parseCityStateZip(payload.hsc_property_address);
      if(p){ city = city || p.city; state = state || p.state; zip = zip || p.zip; }
}

    // ✅ Deal name: clean, no double dashes
    const dealname = `Security Lead — ${redacted_location} — ${time_line} — ${home_ownership}`;
    const z3 = zip3(zip);
    const redacted_location = (city && state ? `${city}, ${state}` : "Location Unknown") + (z3 ? ` ${z3}xx` : "");

    // ✅ submit contact to Account #1 form (does NOT block deal)
    const contactSubmit = await submitContactToForm(payload, lead_id);

    const pipeline = process.env.HUBSPOT_DEAL_PIPELINE_ID || "default";
    const stageQualified = process.env.HUBSPOT_DEAL_STAGE_QUALIFIED || "appointmentscheduled";
    // ✅ Deal + line item in Account #2
    const { pipelineId, stageId } = await resolvePipelineAndStage();
    const dealname = `Security Lead — ${redacted_location} — ${time_line} — ${home_ownership}`;

    // keep properties minimal to avoid HubSpot “unknown property” errors
    // REQUIRE lead_id to exist on Deal properties in Account #2
const dealProps = {
dealname,
      pipeline,
      dealstage: stageQualified,
      lead_id,
      listing_status: "Qualified",
      lead_price: String(lead_price),
      redacted_location,
      time_line,
      home_ownership,
      amount: String(lead_price),
      pipeline: pipelineId,
      dealstage: stageId,
      amount: String(Math.round(Number(payload.lead_price || payload.price || 150)) || 150),
      lead_id, // must exist in Account #2
};

    // ✅ Idempotency improvement:
    // If the client already has a deal_id, update it directly (avoids search/index delay duplicates).
    const clientDealId = normalizeSpaces(body.deal_id || "");
    const clientDealId = norm(body.deal_id || "");
let dealId = null;

    if (clientDealId) {
    // 1) patch by deal_id if provided (prevents duplicates)
    if(clientDealId){
const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(clientDealId)}`, { properties: dealProps });
      if (patched.ok) {
        dealId = clientDealId;
      }
      if(patched.ok) dealId = clientDealId;
}

    // If not patched, search by lead_id
    if (!dealId) {
      const existingDeal = await findDealByLeadId(lead_id);
      if (!existingDeal?.id) {
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

        // Fail loud if HubSpot rejects it
        if (!created.ok || !created.json?.id) {
        // FAIL LOUD (this fixes your “no deal + no redirect”)
        if(!created.ok || !created.json?.id){
return {
statusCode: 500,
            headers: corsHeaders(event.headers?.origin),
            headers: cors,
body: JSON.stringify({
              error: "Deal create failed",
              hubspot_status: created.status,
              hubspot_response: created.text,
            }),
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
      } else {
        dealId = existingDeal.id;
        const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: dealProps });
        if (!patched.ok) {
          return {
            statusCode: 500,
            headers: corsHeaders(event.headers?.origin),
            body: JSON.stringify({
              error: "Deal update failed",
              hubspot_status: patched.status,
              hubspot_response: patched.text,
              deal_id: dealId,
            }),
          };
        }
}
}

    // Line item (create once)
    // Line item once
let lineItemId = null;
    if (dealId) {
      const existingLineItems = await getLineItemAssociations(dealId);
      if (!existingLineItems.length) {
    try{
      const existingLis = await getLineItemAssociations(dealId);
      if(existingLis.length) lineItemId = existingLis[0];
      else {
        const price = Math.round(Number(dealProps.amount || 150)) || 150;
lineItemId = await createLineItemForDeal({
dealId,
leadId: lead_id,
          price: lead_price,
          price,
name: `Exclusive Lead — ${redacted_location} — ${time_line} — ${home_ownership}`,
          description: `Redacted listing: ${redacted_location} | Timeline: ${time_line} | Ownership: ${home_ownership}`,
          description: `Redacted listing: ${redacted_location} | Timeline: ${time_line} | Ownership: ${home_ownership}`
});
      } else {
        lineItemId = existingLineItems[0];
}
    }
    }catch(e){ lineItemId = null; }

return {
statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      headers: cors,
body: JSON.stringify({
        ok: true,
        ok:true,
lead_id,
deal_id: dealId,
line_item_id: lineItemId,
        lead_price,
        skipped_contact: skipContact,
      }),
        contact_submit: contactSubmit
      })
};
  } catch (err) {
    console.error("hubspot-sync error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
  } catch(e){
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e?.message || e) }) };
}
}
