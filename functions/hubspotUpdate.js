export async function handler(event) {

  // ---- HANDLE PREFLIGHT ----
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders(event.headers.origin),
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return response(405, { error: "Method Not Allowed" }, event.headers.origin);
  }

  try {
    const data = JSON.parse(event.body);

    if (!data.email) {
      return response(400, { error: "Missing email" }, event.headers.origin);
    }

    const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;

    const properties = {
      risk_score: data.riskScore || "",
      system_summary: data.systemSummary || "",
      equipment_cost: data.equipment || "",
      install_cost: data.install || "",
      monitoring_cost: data.monitoring || "",
      device_list: (data.devices || []).join(", "),
      address: data.address || ""
    };

    const url = `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(data.email)}?idProperty=email`;

    const hubspotResponse = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${HUBSPOT_TOKEN}`
      },
      body: JSON.stringify({ properties })
    });

    const result = await hubspotResponse.json();

    if (!hubspotResponse.ok) {
      return response(400, result, event.headers.origin);
    }

    return response(200, { success: true, result }, event.headers.origin);

  } catch (error) {
    return response(500, { error: error.message }, event.headers.origin);
  }
}


// ---- CORS CONTROL ----
function corsHeaders(origin) {

  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://hubspotgate.netlify.app",
    "http://localhost:8888"
  ];

  if (allowedOrigins.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    };
  }

  return {
    "Access-Control-Allow-Origin": "https://www.homesecurecalculator.com",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}


// ---- RESPONSE WRAPPER ----
function response(code, body, origin) {
  return {
    statusCode: code,
    headers: corsHeaders(origin),
    body: JSON.stringify(body)
  };
}
