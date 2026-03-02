export async function handler(event) {
  const origin = event.headers?.origin || "";

  // Allow exactly the origins you use (add/remove as needed)
  const ALLOWLIST = new Set([
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "https://hubspotgate.netlify.app",
    "https://www.smartenergycalculator.com",
    "https://smartenergycalculator.com",
    "http://localhost:8888",
    "http://localhost:3000"
  ]);

  const allowOrigin = ALLOWLIST.has(origin)
    ? origin
    : "https://www.homesecurecalculator.com";

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
    "Content-Type": "application/json"
  };

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const key =
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    "";

  if (!key) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Missing GOOGLE_MAPS_API_KEY env var" })
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ key })
  };
}
