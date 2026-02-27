// netlify/functions/hubspot-sync.js
export async function handler(event) {

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  /* ✅ PREFLIGHT */
  if (event.httpMethod === "OPTIONS")
    return { statusCode: 200, headers, body: "ok" };

  try {

    const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
    if (!HS_TOKEN)
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing HS token" }) };

    const body = JSON.parse(event.body || "{}");
    const payload = body.payload || {};
    const email = payload.email;

    if (!email)
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing email" }) };

    const lead_id = payload.lead_id || Date.now().toString();

    const hsAuth = {
      Authorization: `Bearer ${HS_TOKEN}`,
      "Content-Type": "application/json"
    };

    /* ⭐ SEARCH */
    const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
      method: "POST",
      headers: hsAuth,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }]
      })
    });

    const searchJson = await searchRes.json();
    let dealId = searchJson.results?.[0]?.id;

    /* ⭐ CREATE */
    if (!dealId) {
      const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals", {
        method: "POST",
        headers: hsAuth,
        body: JSON.stringify({
          properties: {
            dealname: `HSC ${payload.time_line || ""} ${payload.home_ownership || ""}`,
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
      headers,
      body: JSON.stringify({ ok: true, deal_id: dealId, lead_id })
    };

  } catch (e) {
    console.error(e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message })
    };
  }
}
