export async function handler(event) {

  if (event.httpMethod !== "POST") {
    return { statusCode: 405 };
  }

  try {
    const { payload, risk } = JSON.parse(event.body);

    const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;

    if (!token) {
      throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");
    }

    /* =============================
       1️⃣ FIND CONTACT BY EMAIL
    ============================= */

    const searchRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: "email",
              operator: "EQ",
              value: payload.email
            }]
          }]
        })
      }
    );

    const searchData = await searchRes.json();

    if (!searchData.results?.length) {
      throw new Error("Contact not found");
    }

    const contactId = searchData.results[0].id;

    /* =============================
       2️⃣ CREATE DEAL
    ============================= */

    const dealRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/deals",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          properties: {
            dealname: `Security Report - ${payload.firstname} ${payload.lastname}`,
            pipeline: "default",
            dealstage: "appointmentscheduled",
            amount: payload.hsc_upfront || payload.upfront || 0,
            hsc_risk_score: payload.hsc_risk_score || 0
          }
        })
      }
    );

    const dealData = await dealRes.json();
    const dealId = dealData.id;

    /* =============================
       3️⃣ ASSOCIATE CONTACT ↔ DEAL
    ============================= */

    await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/contacts/${contactId}/3`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    /* =============================
       4️⃣ CREATE LINE ITEM
    ============================= */

    const lineItemRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/line_items",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          properties: {
            name: "Smart Home Security System",
            price: payload.hsc_upfront || payload.upfront || 0,
            quantity: 1
          }
        })
      }
    );

    const lineItemData = await lineItemRes.json();
    const lineItemId = lineItemData.id;

    /* =============================
       5️⃣ ASSOCIATE LINE ITEM ↔ DEAL
    ============================= */

    await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/line_items/${lineItemId}/20`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        dealId,
        lineItemId
      })
    };

  } catch (err) {
    console.error("Deal creation error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}
