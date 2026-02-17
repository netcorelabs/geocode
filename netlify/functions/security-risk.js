exports.handler = async function(event) {

  const headers = {
  "Access-Control-Allow-Origin": "https://www.homesecurecalculator.com",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS"
};


  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const { lat, lng } = event.queryStringParameters || {};

  if (!lat || !lng) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing coordinates" })
    };
  }

  // SIMPLE TEST RESPONSE (to confirm function works)

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      test: "Function working",
      lat,
      lng,
      riskScore: 55,
      exposureScore: 42,
      responseMinutes: 7,
      violent: 100,
      property: 250,
      zone: "Moderate"
    })
  };
};
