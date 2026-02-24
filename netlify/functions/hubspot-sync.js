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
      "Access-Control-Allow-Headers": "Content-Type",
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

  const HS_HEADERS = { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" };

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  async function hsPost(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "POST",
      headers: HS_HEADERS,
      body: JSON.stringify(body),
    });
  }

  async function hsPatch(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "PATCH",
      headers: HS_HEADERS,
      body: JSON.stringify(body),
    });
  }

  async function hsGet(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: { Authorization: `Bearer ${HS_TOKEN}` } });
  }

  function normalizeSpaces(str) { return String(str || "").replace(/\s+/g, " ").trim(); }
  function zip3(zip) {
    const m = String(zip || "").match(/\b(\d{3})\d{2}(?:-\d{4})?\b/);
    return m ? m[1] : "";
  }
  function redactedLocationFromPayload(payload){
    const city = normalizeSpaces(payload.city || "");
    const st = normalizeSpaces(payload.state_code || payload.state || "");
    const z = normalizeSpaces(payload.postal_code || payload.zip || "");
    const z3 = zip3(z);
    const loc = [city, st].filter(Boolean).join(", ");
    return loc ? (loc + (z3 ? ` ${z3}xx` : "")) : "";
  }

  async function findDealByLeadId(leadId) {
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id", "dealname"],
      limit: 1,
    });
    return r.ok && r.json?.results?.[0] ? r.json.results[0] : null;
  }

  async function getLineItemAssociations(dealId) {
    const r = await hsGet(`/crm/v3/objects/deals/${dealId}/associations/line_items`);
    return (r.json?.results || []).map((x) => x.id).filter(Boolean);
  }

  async function createLineItemForDeal({ dealId, leadId, price, description, name }) {
    // associationTypeId 20 = line item -> deal
    const r = await hsPost("/crm/v3/objects/line_items", {
      properties: { name, description, quantity: 1, price: price, hs_sku: `LEAD-${leadId}` },
      associations: [
        { to: { id: Number(dealId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 20 }] },
      ],
    });
    return r.ok ? String(r.json?.id || "") : "";
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const payload = body.payload || {};
    const options = body.options || {};
    const skipContact = !!options.skip_contact;

    // lead_id stable
    const incomingLead = normalizeSpaces(payload.lead_id);
    const lead_id = incomingLead || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

    // IMPORTANT: skip contact entirely when requested
    if (!skipContact) {
      // If you ever want contact upsert here again, put it back.
      // Right now: your Contact should be handled by HubSpot form (account #1), not by this function.
    }

    const pipeline = process.env.HUBSPOT_DEAL_PIPELINE_ID || "default";
    const stage = process.env.HUBSPOT_DEAL_STAGE_QUALIFIED || "appointmentscheduled";

    const loc = redactedLocationFromPayload(payload);
    const baseDealName = loc ? `Security Lead — ${loc} — ${lead_id}` : `Security Lead — ${lead_id}`;

    const dealProps = {
      dealname: baseDealName,
      pipeline,
      dealstage: stage,
      lead_id,
      listing_status: "Qualified",
      redacted_location: loc || "",
      time_line: normalizeSpaces(payload.time_line || "Researching"),
      home_ownership: normalizeSpaces(payload.home_ownership || "Unknown"),
      hsc_risk_score: payload.hsc_risk_score ?? "",
      hsc_devices: payload.hsc_devices || "",
      hsc_monthly: payload.hsc_monthly ?? payload.monthly ?? "",
      hsc_upfront: payload.hsc_upfront ?? payload.upfront ?? "",
      hsc_property_address: payload.hsc_property_address || payload.address || "",
    };

    const existing = await findDealByLeadId(lead_id);

    let deal_id = "";
    if (!existing?.id) {
      const created = await hsPost("/crm/v3/objects/deals", { properties: dealProps });
      if (!created.ok || !created.json?.id) {
        return { statusCode: 502, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error:"Deal create failed", detail: created.text }) };
      }
      deal_id = String(created.json.id);
    } else {
      deal_id = String(existing.id);
      const patched = await hsPatch(`/crm/v3/objects/deals/${deal_id}`, { properties: dealProps });
      if(!patched.ok){
        return { statusCode: 502, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error:"Deal update failed", detail: patched.text }) };
      }
    }

    // set final name to include deal_id (your requirement)
    const finalLoc = loc || "";
    const finalName = finalLoc ? `Security Lead — ${finalLoc} — ${deal_id}` : `Security Lead — ${deal_id}`;
    await hsPatch(`/crm/v3/objects/deals/${deal_id}`, { properties: { dealname: finalName } });

    // line item: create if missing
    let line_item_id = "";
    const li = await getLineItemAssociations(deal_id);
    if (li.length) {
      line_item_id = String(li[0]);
    } else {
      const price = Number(payload.lead_price || payload.price || 0) || 0;
      line_item_id = await createLineItemForDeal({
        dealId: deal_id,
        leadId: lead_id,
        price,
        name: `Exclusive Lead — ${finalLoc || "Location"} — ${deal_id}`,
        description: `Lead ID: ${lead_id}`,
      });
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ ok:true, lead_id, deal_id, line_item_id }),
    };
  } catch (err) {
    console.error("hubspot-sync error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
