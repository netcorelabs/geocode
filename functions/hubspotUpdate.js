export async function handler(event) {

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(event.headers.origin), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(event.headers.origin), body: "Method Not Allowed" };
  }

  try {
    const data = JSON.parse(event.body);

    if(!data.email) return { statusCode: 400, headers: corsHeaders(event.headers.origin), body: JSON.stringify({ error:"Missing email" }) };

    const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;

    const properties = {
      risk_score: data.riskScore||"",
      system_summary: data.systemSummary||"",
      equipment_cost: data.equipment||"",
      install_cost: data.install||"",
      monitoring_cost: data.monitoring||"",
      device_list: (data.devices||[]).join(", "),
      address: data.address||""
    };

    const url = `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(data.email)}?idProperty=email`;

    const hubRes = await fetch(url, {
      method:"PATCH",
      headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${HUBSPOT_TOKEN}` },
      body: JSON.stringify({ properties })
    });

    const result = await hubRes.json();

    if(!hubRes.ok) return { statusCode:400, headers:corsHeaders(event.headers.origin), body:JSON.stringify(result) };

    return { statusCode:200, headers:corsHeaders(event.headers.origin), body:JSON.stringify({ success:true, result }) };

  } catch(err) {
    return { statusCode:500, headers:corsHeaders(event.headers.origin), body:JSON.stringify({ error:err.message }) };
  }
}

function corsHeaders(origin) {
  const allowedOrigins = ["https://www.homesecurecalculator.com","https://hubspotgate.netlify.app"];
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}
