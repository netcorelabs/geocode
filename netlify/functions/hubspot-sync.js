// netlify/functions/hubspot-sync.js
import fetch from "node-fetch";
import crypto from "crypto";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://www.homesecurecalculator.com",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

export async function handler(event) {

  /* ✅ HANDLE PREFLIGHT */
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "ok" };
  }

  try {

    const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
    if (!HS_TOKEN)
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: "Missing HS token" }) };

    const hsAuth = {
      Authorization: `Bearer ${HS_TOKEN}`,
      "Content-Type": "application/json"
    };

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch (e) {}

    const payload = body.payload || {};
    const email = String(payload.email || "").trim();

    if (!email)
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Missing payload.email" }) };

    let lead_id = String(payload.lead_id || "");
    if (!lead_id) lead_id = crypto.randomUUID();

    /* ⭐ SEARCH DEAL BY EMAIL */
    const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
      method: "POST",
      headers: hsAuth,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
        properties: ["dealname"]
      })
    });

    const searchJson = await searchRes.json();
    let dealId = searchJson.results?.[0]?.id || null;

    /* ⭐ CREATE DEAL IF NOT FOUND */
    if (!dealId) {
      const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals", {
        method: "POST",
        headers: hsAuth,
        body: JSON.stringify({
          properties: {
            dealname: `HSC Lead ${payload.firstname || ""} ${payload.lastname || ""} (${payload.time_line || ""} ${payload.home_ownership || ""})`,
            email,
            lead_id
          }
        })
      });

      const createJson = await createRes.json();
      dealId = createJson.id;
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ok: true, lead_id, deal_id: dealId })
    };

  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Server error", details: err.message })
    };
  }
}
