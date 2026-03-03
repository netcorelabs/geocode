"Access-Control-Allow-Methods": "POST, OPTIONS"
};

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "ok" };
  if (event.httpMethod === "OPTIONS")
    return { statusCode: 200, headers, body: "ok" };

try {
const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
    if (!HS_TOKEN) return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing HS token" }) };
    if (!HS_TOKEN) throw new Error("Missing HS token");

const body = JSON.parse(event.body || "{}");
const payload = body.payload || {};
    const email = (payload.email || "").trim();

    const email = payload.email?.trim();
if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing email" }) };

    const lead_id = payload.lead_id || Date.now().toString();

const hsAuth = {
Authorization: `Bearer ${HS_TOKEN}`,
"Content-Type": "application/json"
};

    // 1️⃣ Search for existing deal by email
    // ---------- 1️⃣ Search for existing deal ----------
const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
method: "POST",
headers: hsAuth,
body: JSON.stringify({
filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
        properties: ["dealname", "email", "lead_id"],
        limit: 1
        properties: ["dealname", "amount", "lead_id"]
})
});

const searchJson = await searchRes.json();
let dealId = searchJson.results?.[0]?.id;

    // 2️⃣ Create deal if not found
    // ---------- 2️⃣ Create deal if not found ----------
if (!dealId) {
      const lead_id = payload.lead_id || Date.now().toString();
      const dealName = `HSC ${payload.time_line || ""} ${payload.home_ownership || ""} — C${lead_id}`;

const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals", {
method: "POST",
headers: hsAuth,
body: JSON.stringify({
properties: {
            dealname: dealName,
            dealname: `HSC ${payload.time_line || ""} ${payload.home_ownership || ""}`.trim(),
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
      if (!dealId) throw new Error(`Failed to create deal: ${JSON.stringify(createJson)}`);
    }

      // ✅ Optional: Wait 200-300ms for HubSpot to fully index the deal (avoids "deal not ready")
      await new Promise(resolve => setTimeout(resolve, 300));
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

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, deal_id: dealId, lead_id: payload.lead_id || null }) };
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

  } catch (err) {
    console.error("hubspot-sync error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || err }) };
  } catch (e) {
    console.error("[HSRESULTS] hubspot-sync error:", e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
}
}
