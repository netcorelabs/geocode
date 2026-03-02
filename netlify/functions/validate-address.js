export async function handler(event) {
  const origin = event.headers?.origin || "";

  // ✅ Allowlist your frontends
  const ALLOWLIST = new Set([
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "https://hubspotgate.netlify.app"
  ]);

  const allowOrigin = ALLOWLIST.has(origin) ? origin : "https://www.homesecurecalculator.com";

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const apiKey = process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY || "";
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing GOOGLE_ADDRESS_VALIDATION_API_KEY" }) };
  }

  let req;
  try {
    req = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  // Basic hardening (avoid huge payloads)
  const bodyStr = JSON.stringify(req || {});
  if (bodyStr.length > 20_000) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: "Payload too large" }) };
  }

  // Address Validation API endpoint :contentReference[oaicite:7]{index=7}
  const url = "https://addressvalidation.googleapis.com/v1:validateAddress?key=" + encodeURIComponent(apiKey);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyStr
    });

    const text = await resp.text();
    return { statusCode: resp.status, headers, body: text || "{}" };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Upstream request failed", detail: String(e) }) };
  }
}
