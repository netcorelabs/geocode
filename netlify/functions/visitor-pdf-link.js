// netlify/functions/visitor-pdf-link.js
export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "https://www.netcoreleads.com",
    "https://netcoreleads.com",
    "https://api.netcoreleads.com",
    "https://hubspotgate.netlify.app",
  ];

  function corsHeaders(originRaw) {
    const origin = (originRaw || "").trim();

    // If no Origin header (direct browser hit), allow all
    const allowOrigin = origin
      ? (allowedOrigins.includes(origin) ? origin : allowedOrigins[0])
      : "*";

    return {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Vary": "Origin",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    };
  }

  const originHeader = event.headers?.origin || event.headers?.Origin || "";

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(originHeader), body: "" };
  }

  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders(originHeader),
      body: JSON.stringify({ error: "Method Not Allowed", allowed: ["GET", "POST", "OPTIONS"] }),
    };
  }

  const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";
  if (!HS_TOKEN) {
    return {
      statusCode: 500,
      headers: corsHeaders(originHeader),
      body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }),
    };
  }

  const hsAuthHeaders = { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" };

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  try {
    // GET: /visitor-pdf-link?lead_id=XYZ
    // POST: { "lead_id": "XYZ" }
    let lead_id = "";
    if (event.httpMethod === "GET") {
      lead_id = String(event.queryStringParameters?.lead_id || "").trim();
    } else {
      const body = JSON.parse(event.body || "{}");
      lead_id = String(body.lead_id || "").trim();
    }

    if (!lead_id) {
      return {
        statusCode: 400,
        headers: corsHeaders(originHeader),
        body: JSON.stringify({ error: "Missing lead_id" }),
      };
    }

    // Find deal by lead_id
    const dealSearch = await fetchJson("https://api.hubapi.com/crm/v3/objects/deals/search", {
      method: "POST",
      headers: hsAuthHeaders,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: lead_id }] }],
        properties: ["lead_id", "deliverable_pdf_file_id"],
        limit: 1,
      }),
    });

    const deal = dealSearch.json?.results?.[0] || null;
    if (!deal?.id) {
      return {
        statusCode: 404,
        headers: corsHeaders(originHeader),
        body: JSON.stringify({ error: "Deal not found for lead_id", lead_id }),
      };
    }

    const pdfFileId = String(deal.properties?.deliverable_pdf_file_id || "").trim();
    if (!pdfFileId) {
      return {
        statusCode: 409,
        headers: corsHeaders(originHeader),
        body: JSON.stringify({ error: "PDF not ready yet", lead_id }),
      };
    }

    // Signed URL for PRIVATE file
    const signed = await fetchJson(
      `https://api.hubapi.com/files/v3/files/${encodeURIComponent(pdfFileId)}/signed-url`,
      { method: "GET", headers: { Authorization: `Bearer ${HS_TOKEN}` } }
    );

    const url = String(signed.json?.url || "").trim();
    if (!signed.ok || !url) {
      return {
        statusCode: 500,
        headers: corsHeaders(originHeader),
        body: JSON.stringify({ error: signed.text || "Failed to create signed URL" }),
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(originHeader),
      body: JSON.stringify({ ok: true, lead_id, pdf_url: url }),
    };
  } catch (err) {
    console.error("visitor-pdf-link error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(originHeader),
      body: JSON.stringify({ error: String(err?.message || err) }),
    };
  }
}
