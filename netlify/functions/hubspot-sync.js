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
    const allowOrigin = origin
      ? (allowedOrigins.includes(origin) ? origin : allowedOrigins[0])
      : "*";
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

  const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";
  if (!HS_TOKEN) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
  }

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

  function normalizeSpaces(str) { return String(str || "").replace(/\s+/g, " ").trim(); }
  function safeZip3(zip) {
    const m = String(zip || "").match(/\b(\d{3})\d{2}(?:-\d{4})?\b/);
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
  }

  function computeLeadPrice(payload, risk) {
    const explicit = Number(payload.lead_price ?? payload.leadPrice ?? payload.price ?? NaN);
    if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);

    const timeLine = normalizeTimeline(payload.time_line);
    const own = normalizeOwnership(payload.home_ownership);
    const riskScore = Number(payload.hsc_risk_score ?? risk?.scoring?.riskScore ?? NaN);

    const base = 85;
    const bump = Number.isFinite(riskScore) ? Math.max(0, Math.min(100, riskScore)) * 1.2 : 40;

    const timelineMult =
      timeLine === "ASAP" ? 1.4 :
      timeLine === "1 Week" ? 1.25 :
      timeLine === "2 - 3 Weeks" ? 1.1 :
      timeLine === "30 Days +" ? 0.9 : 1.0;

    const ownerMult = own === "Owner" ? 1.15 : 1.0;

    const raw = (base + bump) * timelineMult * ownerMult;
    const clamped = Math.max(49, Math.min(399, raw));
    return Math.round(clamped / 5) * 5;
  }

  async function dealPropertyExists(name) {
    const r = await hsGet(`/crm/v3/properties/deals/${encodeURIComponent(name)}`);
    return r.ok;
  }

  async function resolvePipelineAndStage() {
    // If you set env vars, we will try to honor them. Otherwise pick first available.
    const wantPipeline = (process.env.HUBSPOT_DEAL_PIPELINE_ID || "").trim();
    const wantStage = (process.env.HUBSPOT_DEAL_STAGE_QUALIFIED || "").trim();

    const r = await hsGet("/crm/v3/pipelines/deals");
    if (!r.ok || !Array.isArray(r.json?.results) || !r.json.results.length) {
      // fallback to common defaults if pipelines endpoint fails
      return { pipelineId: wantPipeline || "default", stageId: wantStage || "appointmentscheduled" };
    }

    const pipelines = r.json.results;
    let pipeline = wantPipeline ? pipelines.find(p => String(p.id) === wantPipeline) : null;
    if (!pipeline) pipeline = pipelines[0];

    const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];
    let stage = wantStage ? stages.find(s => String(s.id) === wantStage) : null;
    if (!stage) stage = stages[0] || null;

    return { pipelineId: String(pipeline.id), stageId: stage ? String(stage.id) : (wantStage || "") };
  }

  async function findDealByLeadId(leadId) {
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id"],
      limit: 1,
    });
    return r.ok && r.json?.results?.[0] ? r.json.results[0] : null;
  }

  async function getLineItemAssociations(dealId) {
    const r = await hsGet(`/crm/v3/objects/deals/${dealId}/associations/line_items`);
    return (r.json?.results || []).map((x) => x.id).filter(Boolean);
  }

  async function createLineItemForDeal({ dealId, leadId, price, description, name }) {
    // associationTypeId 20 = line item -> deal (HubSpot-defined)
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

  async function findContactIdByEmail(email) {
    const r = await hsPost("/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email"],
      limit: 1,
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
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const payload = body.payload || {};
    const risk = body.risk || null;

    // ✅ NEW: allow skipping contact upsert
    const skipContact =
      body?.options?.skip_contact === true ||
      String(process.env.HUBSPOT_SYNC_SKIP_CONTACT || "0") === "1";

    const email = normalizeSpaces(payload.email);
    if (!email) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing payload.email" }) };
    }

    const lead_id =
      normalizeSpaces(payload.lead_id) ||
      (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const home_ownership = normalizeOwnership(payload.home_ownership);
    const time_line = normalizeTimeline(payload.time_line);

    const city = normalizeSpaces(payload.city || "");
    const stateCode = normalizeSpaces(payload.state_code || payload.state || "");
    const zip = normalizeSpaces(payload.postal_code || payload.zip || "");
    const zip3 = safeZip3(zip);
    const redacted_location = [city, stateCode].filter(Boolean).join(", ") + (zip3 ? ` ${zip3}xx` : "");

    const lead_price = computeLeadPrice(payload, risk);

    // ✅ CONTACT (optional)
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
    }

    // ✅ RESOLVE a real pipeline + stage that exist (prevents silent deal create failure)
    const { pipelineId, stageId } = await resolvePipelineAndStage();

    // ✅ Build deal properties safely (only include custom props if they exist)
    const baseDealProps = {
      dealname: `Security Lead — ${redacted_location || "Location"} — ${time_line || "—"} — ${home_ownership || "—"}`,
      pipeline: pipelineId,
      dealstage: stageId,
      amount: String(lead_price),
    };

    const customPropsWanted = {
      lead_id,
      listing_status: "Qualified",
      lead_price: String(lead_price),
      redacted_location,
      time_line,
      home_ownership,
    };

    const customKeys = Object.keys(customPropsWanted);
    const existsFlags = await Promise.all(customKeys.map(k => dealPropertyExists(k)));
    const safeCustom = {};
    customKeys.forEach((k, i) => { if (existsFlags[i]) safeCustom[k] = customPropsWanted[k]; });

    const dealProps = { ...baseDealProps, ...safeCustom };

    // ✅ Create or update deal
    const existingDeal = await findDealByLeadId(lead_id);
    let dealId = null;

    if (!existingDeal?.id) {
      const created = await hsPost("/crm/v3/objects/deals", { properties: dealProps });

      // ✅ FAIL LOUD (this is the main fix)
      if (!created.ok || !created.json?.id) {
        return {
          statusCode: 500,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({
            error: "Deal create failed",
            hubspot_status: created.status,
            hubspot_response: created.text,
            pipelineId,
            stageId,
            tried_properties: Object.keys(dealProps),
          }),
        };
      }

      dealId = created.json.id;
    } else {
      dealId = existingDeal.id;

      const patched = await hsPatch(`/crm/v3/objects/deals/${dealId}`, { properties: dealProps });
      if (!patched.ok) {
        return {
          statusCode: 500,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({
            error: "Deal update failed",
            hubspot_status: patched.status,
            hubspot_response: patched.text,
            deal_id: dealId,
            pipelineId,
            stageId,
          }),
        };
      }
    }

    // ✅ Line item (optional, but helpful)
    let lineItemId = null;
    try {
      const existingLineItems = await getLineItemAssociations(dealId);
      if (!existingLineItems.length) {
        lineItemId = await createLineItemForDeal({
          dealId,
          leadId: lead_id,
          price: lead_price,
          name: `Exclusive Lead — ${redacted_location} — ${time_line} — ${home_ownership}`,
          description: `Redacted listing: ${redacted_location} | Timeline: ${time_line} | Ownership: ${home_ownership}`,
        });
      } else {
        lineItemId = existingLineItems[0];
      }
    } catch (e) {
      // don't fail the whole request if line item fails
      lineItemId = null;
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        lead_id,
        deal_id: dealId,
        line_item_id: lineItemId,
        lead_price,
        pipelineId,
        stageId,
        skipped_contact: skipContact,
      }),
    };
  } catch (err) {
    console.error("hubspot-sync error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: String(err?.message || err) }),
    };
  }
}
