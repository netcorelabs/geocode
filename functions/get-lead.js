exports.handler = async (event) => {

  const leadId = event.queryStringParameters.lead_id;
  if (!leadId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing lead_id" })
    };
  }

  try {

    // 🔹 Query HubSpot by lead_id property
    const response = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: "lead_id",
              operator: "EQ",
              value: leadId
            }]
          }]
        })
      }
    );

    const data = await response.json();

    if (!data.results || !data.results.length) {
      return { statusCode: 404, body: JSON.stringify({ error: "Lead not found" }) };
    }

    const contact = data.results[0].properties;

    return {
      statusCode: 200,
      body: JSON.stringify(contact)
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error" })
    };
  }
};
