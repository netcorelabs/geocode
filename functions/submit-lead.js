// netlify/functions/submit-lead.js

export async function handler(event) {

  const ALLOWED_ORIGINS = [
    "https://www.homesecurecalculator.com",
    "https://hubspotgate.netlify.app"
  ];

  function corsHeaders(origin) {
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    };
  }

  // Respond to preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders(event.headers.origin),
      body: ""
    };
  }

  // Only accept POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders(event.headers.origin),
      body: "Method Not Allowed"
    };
  }

  try {
    const data = JSON.parse(event.body);

    const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;
    const HUBSPOT_FORM_ID = process.env.HUBSPOT_FORM_ID;

    if (!HUBSPOT_PORTAL_ID || !HUBSPOT_FORM_ID) {
      throw new Error("HubSpot IDs not set in environment variables");
    }

    const hubspotPayload = {
      fields: [
        { name: "firstname", value: data.firstname },
        { name: "lastname", value: data.lastname },
        { name: "email", value: data.email },
        { name: "phone", value: data.phone },
        { name: "address", value: data.address },
        { name: "utm_source", value: data.utm_source || "" },
        { name: "utm_medium", value: data.utm_medium || "" },
        { name: "utm_campaign", value: data.utm_campaign || "" },
        { name: "utm_term", value: data.utm_term || "" },
        { name: "utm_content", value: data.utm_content || "" }
      ],
      context: { pageUri: data.pageUri || "" }
    };

    const res = await fetch(
      `https://api.hsforms.com/submissions/v3/integration/submit/${HUBSPOT_PORTAL_ID}/${HUBSPOT_FORM_ID}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hubspotPayload)
      }
    );

    if (!res.ok) {
      const text = await res.text();
      return { statusCode: 400, headers: corsHeaders(event.headers.origin), body: text };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers.origin),
      body: JSON.stringify({ success: true })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers.origin),
      body: JSON.stringify({ error: err.message })
    };
  }
}
