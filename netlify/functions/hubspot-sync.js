// netlify/functions/hubspot-sync.js
export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "ok" };

  try {
    const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
    if (!HS_TOKEN) return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing HS token" }) };

    const body = JSON.parse(event.body || "{}");
    const payload = body.payload || {};
    const email = (payload.email || "").trim();

    if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing email" }) };

    const hsAuth = {
      Authorization: `Bearer ${HS_TOKEN}`,
      "Content-Type": "application/json"
    };

    // 1️⃣ Search for existing deal by email
    const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
      method: "POST",
      headers: hsAuth,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
        properties: ["dealname", "email", "lead_id"],
        limit: 1
      })
    });

    const searchJson = await searchRes.json();
    let dealId = searchJson.results?.[0]?.id;

    // 2️⃣ Create deal if not found
    if (!dealId) {
      const lead_id = payload.lead_id || Date.now().toString();
      const dealName = `HSC ${payload.time_line || ""} ${payload.home_ownership || ""} — C${lead_id}`;

      const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals", {
        method: "POST",
        headers: hsAuth,
        body: JSON.stringify({
          properties: {
            dealname: dealName,
            email,
            lead_id,
            amount: payload.lead_price || 0,
            lead_status: "New Lead"
          }
        })
      });

      const createJson = await createRes.json();

      if (!createJson?.id) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Failed to create deal", detail: JSON.stringify(createJson) }) };
      }

      dealId = createJson.id;

      // ✅ Optional: Wait 200-300ms for HubSpot to fully index the deal (avoids "deal not ready")
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, deal_id: dealId, lead_id: payload.lead_id || null }) };

  } catch (err) {
    console.error("hubspot-sync error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || err }) };
  }
}
