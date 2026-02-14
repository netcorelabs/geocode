export async function handler(event) {
  try {
    const body = JSON.parse(event.body);
    const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;

    await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        properties: {
          email: body.email,
          risk_score: body.risk_score,
          crime_weighted_score: body.crime_weighted_score
        }
      })
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}
