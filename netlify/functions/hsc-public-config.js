// netlify/functions/hsc-public-config.js
// FULL DROP-IN — returns public-safe config with proper CORS on ALL responses

export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "https://www.netcoreleads.com",
    "https://netcoreleads.com",
    "https://api.netcoreleads.com",
    "https://hubspotgate.netlify.app",
  ];

  function corsHeaders() {
    const origin = String(event.headers?.origin || "").trim();
    const allowOrigin = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    return {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    };
  }

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ ok: false, error: "Method Not Allowed" }) };
  }

  // Public-only values (safe to expose)
  const recaptcha_site_key = String(process.env.RECAPTCHA_V3_SITE_KEY || "").trim();
  const privacy_url = String(process.env.HSC_PRIVACY_URL || "https://www.homesecurecalculator.com/privacy").trim();

  const consent_process_text = String(
    process.env.HSC_CONSENT_PROCESS_TEXT ||
      "I agree to allow Home Secure Calculator to store and process my personal data to provide my report."
  ).trim();

  const consent_comm_text = String(
    process.env.HSC_CONSENT_COMM_TEXT ||
      "I also agree to receive marketing information related to my request."
  ).trim();

  // Optional numeric subscription type id for communications consent
  const subscription_type_id = Number(process.env.HS_SUBSCRIPTION_TYPE_ID || "0") || 0;

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      ok: true,
      recaptcha_site_key,
      privacy_url,
      consent_process_text,
      consent_comm_text,
      subscription_type_id,
    }),
  };
}
