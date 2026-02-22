// netlify/functions/issue-delivery.js
import crypto from "node:crypto";

export async function handler(event) {
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
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const API_KEY = process.env.LEAD_STORE_API_KEY || "";
  const providedKey = event.headers?.["x-api-key"] || event.headers?.["X-API-Key"] || "";
  if (API_KEY && providedKey !== API_KEY) return { statusCode: 401, body: "Unauthorized" };

  const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";
  if (!HS_TOKEN) return { statusCode: 500, body: "Missing HUBSPOT_PRIVATE_APP_TOKEN" };

  // ✅ Use branded API domain if available (recommended: https://api.netcoreleads.com)
  const apiBase =
    (process.env.LEAD_STORE_API_URL || "").replace(/\/$/, "") ||
    `https://${event.headers?.host || "hubspotgate.netlify.app"}`;

  async function readText(res){ try{return await res.text();}catch{return "";} }
  async function fetchJson(url, options={}){
    const res = await fetch(url, options);
    const text = await readText(res);
    let json=null; try{ json = text ? JSON.parse(text) : null; } catch { json=null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  const hsHeaders = { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type":"application/json" };
  const body = JSON.parse(event.body || "{}");
  const dealId = String(body.deal_id || "").trim();
  if (!dealId) return { statusCode: 400, body: "Missing deal_id" };

  const token = crypto.randomUUID();
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

  // ✅ Sold after payment
  const soldStage = process.env.HUBSPOT_DEAL_STAGE_PAID || "";
  const patch = {
    properties: {
      listing_status: "Sold",
      delivery_token: token,
      delivery_expires_at: String(expiresAt),
      ...(soldStage ? { dealstage: soldStage } : {}),
    },
  };

  const upd = await fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
    method: "PATCH",
    headers: hsHeaders,
    body: JSON.stringify(patch),
  });
  if (!upd.ok) return { statusCode: 500, body: upd.text || "Failed to update deal" };

  const deliverablesUrl =
    `${apiBase}/.netlify/functions/deliverables?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(token)}`;
  const pdfUrl =
    `${apiBase}/.netlify/functions/download-pdf?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(token)}`;
  const csvUrl =
    `${apiBase}/.netlify/functions/download-csv?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(token)}`;

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
    }),
  };
}
