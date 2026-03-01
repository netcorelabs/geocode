// netlify/functions/hubspot-sync.js
export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS")
    return { statusCode: 200, headers, body: "ok" };

  try {
    const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
    if (!HS_TOKEN) throw new Error("Missing HS token");

    const body = JSON.parse(event.body || "{}");
    const payload = body.payload || {};
    const email = payload.email?.trim();
    if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing email" }) };

    const lead_id = payload.lead_id || Date.now().toString();

    const hsAuth = {
      Authorization: `Bearer ${HS_TOKEN}`,
      "Content-Type": "application/json"
    };

    // ---------- 1️⃣ Search for existing deal ----------
    const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
      method: "POST",
      headers: hsAuth,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
        properties: ["dealname", "amount", "lead_id"]
      })
    });
    const searchJson = await searchRes.json();
    let dealId = searchJson.results?.[0]?.id;

    // ---------- 2️⃣ Create deal if not found ----------
    if (!dealId) {
      const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals", {
        method: "POST",
        headers: hsAuth,
        body: JSON.stringify({
          properties: {
            dealname: `HSC ${payload.time_line || ""} ${payload.home_ownership || ""}`.trim(),
            email,
            lead_id,
            lead_status: "New Lead"
          }
        })
      });
      const createJson = await createRes.json();
      dealId = createJson.id;
      if (!dealId) throw new Error(`Failed to create deal: ${JSON.stringify(createJson)}`);
    }

    // ---------- 3️⃣ Call ensure-line-item ----------
    const ensureRes = await fetch("https://api.netcoreleads.com/.netlify/functions/ensure-line-item", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deal_id: dealId,
        lead_id,
        email,
        lead_price: Number(payload.lead_price || 0),
        currency: payload.currency || "USD",
        line_item_name: payload.line_item_name || `Home Secure Lead — ${email}`,
        city: payload.city,
        state: payload.state,
        zip: payload.zip
      })
    });
    const ensureJson = await ensureRes.json();

    if (!ensureRes.ok || ensureJson.error) {
      console.error("[HSRESULTS] ensure-line-item failed", ensureJson);
      return { statusCode: 500, headers, body: JSON.stringify({ error: "ensure-line-item failed", detail: ensureJson }) };
    }

    // ---------- 4️⃣ Return combined result ----------
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        deal_id,
        lead_id,
        line_item_id: ensureJson.line_item_id,
        associationTypeId: ensureJson.associationTypeId,
        amount: ensureJson.amount,
        dealname: ensureJson.dealname
      })
    };

  } catch (e) {
    console.error("[HSRESULTS] hubspot-sync error:", e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
}
