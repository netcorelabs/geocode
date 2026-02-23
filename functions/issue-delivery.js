// netlify/functions/issue-delivery.js
import crypto from "node:crypto";

export async function handler(event) {
  // CORS (mostly irrelevant for server-to-server, but harmless)
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,X-API-Key",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Optional API key protection (keep this if calling from automation / webhook relay)
  const API_KEY = process.env.LEAD_STORE_API_KEY || "";
  const providedKey = event.headers?.["x-api-key"] || event.headers?.["X-API-Key"] || "";
  if (API_KEY && providedKey !== API_KEY) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";
  if (!HS_TOKEN) return { statusCode: 500, body: "Missing HUBSPOT_PRIVATE_APP_TOKEN" };

  // Always return branded links
  const apiBase = (process.env.LEAD_STORE_API_URL || "https://api.netcoreleads.com").replace(/\/$/, "");

  async function readText(res){ try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

  const dealId = String(body.deal_id || "").trim();
  if (!dealId) return { statusCode: 400, body: "Missing deal_id" };

  // Pull deal fields needed for delivery — deal-only, no contact involvement
  const props = [
    "listing_status",
    "delivery_token",
    "delivery_expires_at",
    "deliverable_pdf_file_id",
    "deliverable_csv_file_id",
  ].join(",");

  const dealRes = await fetchJson(
    `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${encodeURIComponent(props)}`,
    { headers: hsAuth }
  );

  if (!dealRes.ok) {
    return { statusCode: 404, body: dealRes.text || "Deal not found" };
  }

  const p = dealRes.json?.properties || {};
  const listingStatus = String(p.listing_status || "");
  const existingToken = String(p.delivery_token || "");
  const existingExp = Number(p.delivery_expires_at || "0");

  const pdfFileId = String(p.deliverable_pdf_file_id || "").trim();
  const csvFileId = String(p.deliverable_csv_file_id || "").trim();

  // Deliverables must exist before issuing access
  if (!pdfFileId || !csvFileId) {
    return {
      statusCode: 409,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Deliverables not ready", deal_id: dealId }),
    };
  }

  // If already sold and token exists (and not expired), return the same links (idempotent)
  if ((listingStatus === "Sold" || listingStatus === "Delivered") && existingToken && (!existingExp || Date.now() < existingExp)) {
    const deliverablesUrl = `${apiBase}/.netlify/functions/deliverables?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(existingToken)}`;
    const pdfUrl = `${apiBase}/.netlify/functions/download-pdf?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(existingToken)}`;
    const csvUrl = `${apiBase}/.netlify/functions/download-csv?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(existingToken)}`;

    return {
      statusCode: 200,
      headers: { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" },
      body: JSON.stringify({
        ok: true,
        deal_id: dealId,
        delivery_token: existingToken,
        delivery_expires_at: existingExp || null,
        deliverables_url: deliverablesUrl,
        pdf_download_url: pdfUrl,
        csv_download_url: csvUrl,
        reused: true,
      }),
    };
  }

  // If already sold but missing token, treat as conflict (avoid issuing twice)
  if (listingStatus === "Sold" || listingStatus === "Delivered") {
    return {
      statusCode: 409,
      headers: { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" },
      body: JSON.stringify({ ok: false, error: "Already sold (no token found). Manual review.", deal_id: dealId }),
    };
  }

  // Issue new delivery token (24h)
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

  // Optional: set HubSpot stage on sold
  const soldStage = process.env.HUBSPOT_DEAL_STAGE_PAID || "";

  const patch = {
    properties: {
      listing_status: "Sold",
      delivery_token: token,
      delivery_expires_at: String(expiresAt),
      ...(soldStage ? { dealstage: soldStage } : {}),
    },
  };

  const upd = await fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
    method: "PATCH",
    headers: { ...hsAuth, "Content-Type":"application/json" },
    body: JSON.stringify(patch),
  });

  if (!upd.ok) {
    return { statusCode: 500, body: upd.text || "Failed to update deal" };
  }

  const deliverablesUrl = `${apiBase}/.netlify/functions/deliverables?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(token)}`;
  const pdfUrl = `${apiBase}/.netlify/functions/download-pdf?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(token)}`;
  const csvUrl = `${apiBase}/.netlify/functions/download-csv?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(token)}`;

  return {
    statusCode: 200,
    headers: { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" },
    body: JSON.stringify({
      ok: true,
      deal_id: dealId,
      delivery_token: token,
      delivery_expires_at: expiresAt,
      deliverables_url: deliverablesUrl,
      pdf_download_url: pdfUrl,
      csv_download_url: csvUrl,
      reused: false,
    }),
  };
}
