export async function handler(event, context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }

  // Return your Google API key securely
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ key: process.env.GOOGLE_MAPS_KEY }),
  };
}
