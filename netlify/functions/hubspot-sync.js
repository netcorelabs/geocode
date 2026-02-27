// netlify/functions/hubspot-sync.js
import fetch from "node-fetch";

export async function handler(event) {

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS")
    return { statusCode: 200, headers: cors };

  try {

    const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
    if (!HS_TOKEN)
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Missing HS token" }) };

    const hsAuth = {
      Authorization: `Bearer ${HS_TOKEN}`,
      "Content-Type": "application/json"
    };

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}

    const payload = body.payload || {};
    const email = String(payload.email || "").trim();
    if (!email)
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Missing payload.email" }) };

    /* Lead ID safe fallback */
    let lead_id = String(payload.lead_id || "");
    if (!lead_id)
      lead_id = Date.now() + "-" + Math.random().toString(16).slice(2);

    /* CONTACT SEARCH */
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
            lead_id
          }
        })
      });

      const cjson = await createContact.json();
      contactId = cjson.id;
    }

    /* DEAL CREATE */
    const createDeal = await fetch("https://api.hubapi.com/crm/v3/objects/deals", {
      method: "POST",
      headers: hsAuth,
      body: JSON.stringify({
        properties: {
          dealname: `HSC Lead ${payload.firstname || ""} ${payload.lastname || ""}`,
          lead_id
        }
      })
    });

    const dealJson = await createDeal.json();

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        ok: true,
        lead_id,
        deal_id: dealJson.id,
        contact_id: contactId
      })
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: String(e) })
    };
  }
}
