// netlify/functions/send-visitor-email.js
// Sends visitor an email with their PDF link.
// NOTE: This uses HubSpot Transactional Single Send API, which requires Transactional Email add-on
// and a configured transactional email (emailId).
//
// Env:
//   HUBSPOT_PRIVATE_APP_TOKEN (required)
//   HUBSPOT_TRANSACTIONAL_EMAIL_ID (required to send)
//
// If you don't have transactional email, this will return a helpful error and the UI should fall back to mailto.

export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "http://www.homesecurecalculator.com",
    "http://homesecurecalculator.com",
    "https://www.netcoreleads.com",
    "https://netcoreleads.com",
    "https://api.netcoreleads.com",
    "https://hubspotgate.netlify.app",
  ];

  function corsHeaders(originRaw) {
    const origin = (originRaw || "").trim();
    const allowOrigin = origin ? (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]) : "*";
    return {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    };
  }

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Method Not Allowed" }) };

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  const EMAIL_ID = String(process.env.HUBSPOT_TRANSACTIONAL_EMAIL_ID || "").trim();
  if (!HS_TOKEN) return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
  if (!EMAIL_ID) {
    return {
      statusCode: 501,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        error: "Transactional email not configured",
        detail: "Set HUBSPOT_TRANSACTIONAL_EMAIL_ID env var (requires HubSpot Transactional Email add-on).",
      }),
    };
  }

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const to = String(body.to || body.email || "").trim();
    const firstname = String(body.firstname || "").trim();
    const lastname  = String(body.lastname || "").trim();

    const pdf_url = String(body.pdf_url || "").trim();
    const csv_url = String(body.csv_url || "").trim();

    const lead_id = String(body.lead_id || "").trim();
    const deal_id = String(body.deal_id || "").trim();

    if (!to) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing to/email" }) };
    if (!pdf_url) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing pdf_url" }) };

    const r = await fetchJson("https://api.hubapi.com/marketing/v3/transactional/single-email/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        emailId: Number(EMAIL_ID),
        message: { to },
        contactProperties: {
          email: to,
          ...(firstname ? { firstname } : {}),
          ...(lastname ? { lastname } : {}),
        },
        customProperties: {
          pdf_url,
          ...(csv_url ? { csv_url } : {}),
          ...(lead_id ? { lead_id } : {}),
          ...(deal_id ? { deal_id } : {}),
        },
      }),
    });

    if (!r.ok) {
      return {
        statusCode: 502,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "HubSpot email send failed",
          status: r.status,
          detail: r.text || JSON.stringify(r.json),
        }),
      };
    }

    return { statusCode: 200, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("send-visitor-email error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
