// File: functions/submit-lead.js

export async function handler(event, context) {
  // CORS headers
  const headers = {
    "Access-Control-Allow-Origin": "*", // replace '*' with 'https://www.homesecurecalculator.com' if you want strict domain control
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers,
    };
  }

  try {
    // Parse the incoming payload
    const payload = JSON.parse(event.body);

    // TODO: Your lead submission logic here
    // For example, submit to HubSpot or store in your database
    // Example POST to HubSpot hidden form
    const HS_PORTAL_ID = "245087053"; 
    const HS_FORM_ID   = "1988f31c-3916-48a8-aa87-d8aae8a217e2";

    const hsBody = {
      fields: [
        { name: "firstname", value: payload.firstname },
        { name: "lastname",  value: payload.lastname },
        { name: "email",     value: payload.email },
        { name: "phone",     value: payload.phone },
        { name: "address",   value: payload.address || "" },
      ],
      context: {
        pageUri: payload.pageUri || "",
        pageName: payload.pageName || "",
      },
    };

    // Submit to HubSpot
    await fetch(`https://api.hsforms.com/submissions/v3/integration/submit/${HS_PORTAL_ID}/${HS_FORM_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(hsBody),
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true }),
    };

  } catch (err) {
    console.error("Lead submission failed:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
}
