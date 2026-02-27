// netlify/functions/hubspot-sync.js
import fetch from "node-fetch";
import crypto from "crypto";

export async function handler(event) {

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN)
    return { statusCode: 500, body: JSON.stringify({ error: "Missing HS token" }) };

  const hsAuth = {
    Authorization: `Bearer ${HS_TOKEN}`,
    "Content-Type": "application/json"
  };

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const payload = body.payload || {};
  const email = String(payload.email || "").trim();
  if (!email)
    return { statusCode: 400, body: JSON.stringify({ error: "Missing payload.email" }) };

  /* --------------------------------------------------
     1️⃣ Lead ID
  -------------------------------------------------- */
  let lead_id = String(payload.lead_id || "");
  if (!lead_id)
    lead_id = crypto.randomUUID?.() || Date.now() + "-" + Math.random().toString(16).slice(2);

  /* --------------------------------------------------
     2️⃣ SALES INTELLIGENCE SCORING
  -------------------------------------------------- */

  const timelineMap = {
    "ASAP": 100,
    "1 Week": 80,
    "2 - 3 Weeks": 60,
    "30 Days +": 30
  };

  const ownershipScore = payload.home_ownership === "Owner" ? 40 : 15;
  const timelineScore = timelineMap[payload.time_line] || 25;
  const riskScore = Math.min(100, timelineScore + ownershipScore);

  /* --------------------------------------------------
     3️⃣ CONTACT SEARCH / CREATE
  -------------------------------------------------- */

  let contactId = null;

  const contactSearch = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST",
    headers: hsAuth,
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email"]
    })
  });

  const contactJson = await contactSearch.json();
  contactId = contactJson.results?.[0]?.id || null;

  if (!contactId) {
    const createContact = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
      method: "POST",
      headers: hsAuth,
      body: JSON.stringify({
        properties: {
          email,
          firstname: payload.firstname,
          lastname: payload.lastname,
          phone: payload.phone,
          hsc_property_address: payload.hsc_property_address,
          lead_id
        }
      })
    });
    const cjson = await createContact.json();
    contactId = cjson.id;
  }

  /* --------------------------------------------------
     4️⃣ DEAL SEARCH BY CONTACT ASSOCIATION
  -------------------------------------------------- */

  let dealId = null;

  const assocDeals = await fetch(
    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}/associations/deals`,
    { method: "GET", headers: hsAuth }
  );

  const assocJson = await assocDeals.json();
  dealId = assocJson.results?.[0]?.id || null;

  /* --------------------------------------------------
     5️⃣ INTELLIGENT DEAL NAME
  -------------------------------------------------- */

  const dealName =
    `HSC ${payload.home_ownership} • ${payload.time_line} • $${payload.upfront} • ${payload.firstname || ""} ${payload.lastname || ""}`.trim();

  /* --------------------------------------------------
     6️⃣ CREATE DEAL IF NEEDED
  -------------------------------------------------- */

  if (!dealId) {
    const createDeal = await fetch("https://api.hubapi.com/crm/v3/objects/deals", {
      method: "POST",
      headers: hsAuth,
      body: JSON.stringify({
        properties: {
          dealname: dealName,
          lead_id,
          hsc_upfront: payload.upfront,
          hsc_monthly: payload.monthly,
          hsc_devices: payload.devices,
          hsc_install_type: payload.install_type,
          hsc_monitoring: payload.monitoring,
          hsc_home_ownership: payload.home_ownership,
          hsc_timeline: payload.time_line,
          hsc_risk_score: riskScore
        }
      })
    });

    const dealJson = await createDeal.json();
    dealId = dealJson.id;

    /* Associate contact to deal */
    await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/contacts/${contactId}/deal_to_contact`,
      { method: "PUT", headers: hsAuth }
    );
  }

  /* --------------------------------------------------
     7️⃣ RESPONSE
  -------------------------------------------------- */

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      lead_id,
      deal_id: dealId,
      contact_id: contactId,
      risk_score: riskScore
    })
  };
}
