// netlify/functions/upload-deliverables.js
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
    const allowOrigin = origin
      ? (allowedOrigins.includes(origin) ? origin : allowedOrigins[0])
      : "*";

    return {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    };
  }

  const originHeader = event.headers?.origin || event.headers?.Origin || "";

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(originHeader), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders(originHeader),
      body: JSON.stringify({ error: "Method Not Allowed", allowed: ["POST", "OPTIONS"] }),
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

  // OPTIONAL: if you later create this deal property, set env var so we can patch it safely.
  // If not set, we will STILL upload CSV but we won't patch it onto the deal (avoids HubSpot 400).
  const CSV_FILE_ID_PROPERTY = (process.env.DELIVERABLE_CSV_FILE_ID_PROPERTY || "").trim();

  const FOLDER_PATH = (process.env.HS_FILES_FOLDER_PATH || "/HomeSecureCalculator").trim();

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  async function uploadFile({ buffer, filename, mime }) {
    const fd = new FormData();
    fd.append("file", new Blob([buffer], { type: mime }), filename);
    fd.append("folderPath", FOLDER_PATH);
    fd.append("options", JSON.stringify({
      access: "PRIVATE",
      overwrite: true,
      duplicateValidationStrategy: "NONE",
    }));

    const res = await fetch("https://api.hubapi.com/files/v3/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${HS_TOKEN}` },
      body: fd,
    });

    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }

    if (!res.ok || !json?.id) {
      throw new Error(`HubSpot file upload failed: HTTP ${res.status} ${text}`);
    }
    return { id: String(json.id).trim() };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const lead_id = String(body.lead_id || "").trim();
    const pdf_base64 = String(body.pdf_base64 || "").trim();
    const csv_text = String(body.csv_text || "").trim();

    const pdf_filename = String(body.pdf_filename || `home-secure-report-${lead_id || Date.now()}.pdf`).trim();
    const csv_filename = String(body.csv_filename || `home-secure-lead-${lead_id || Date.now()}.csv`).trim();

    if (!lead_id) {
      return { statusCode: 400, headers: corsHeaders(originHeader), body: JSON.stringify({ error: "Missing lead_id" }) };
    }
    if (!pdf_base64) {
      return { statusCode: 400, headers: corsHeaders(originHeader), body: JSON.stringify({ error: "Missing pdf_base64" }) };
    }

    // 1) Find deal by lead_id
    const dealSearch = await fetchJson("https://api.hubapi.com/crm/v3/objects/deals/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: lead_id }] }],
        properties: ["lead_id", "deliverable_pdf_file_id"],
        limit: 1,
      }),
    });

    const deal = dealSearch.json?.results?.[0] || null;
    if (!deal?.id) {
      return { statusCode: 404, headers: corsHeaders(originHeader), body: JSON.stringify({ error: "Deal not found for lead_id", lead_id }) };
    }

    // 2) Upload PDF
    const pdfBuffer = Buffer.from(pdf_base64, "base64");
    const pdfUp = await uploadFile({ buffer: pdfBuffer, filename: pdf_filename, mime: "application/pdf" });

    // 3) Upload CSV (optional)
    let csvFileId = "";
    if (csv_text) {
      const csvBuffer = Buffer.from(csv_text, "utf8");
      const csvUp = await uploadFile({ buffer: csvBuffer, filename: csv_filename, mime: "text/csv" });
      csvFileId = csvUp.id;
    }

    // 4) Patch deal with deliverable_pdf_file_id (and optional CSV if property configured)
    const patchProps = { deliverable_pdf_file_id: pdfUp.id };
    if (CSV_FILE_ID_PROPERTY && csvFileId) {
      patchProps[CSV_FILE_ID_PROPERTY] = csvFileId;
    }

    const patch = await fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(deal.id)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: patchProps }),
    });

    if (!patch.ok) {
      return { statusCode: 500, headers: corsHeaders(originHeader), body: JSON.stringify({ error: "Failed to patch deal", detail: patch.text || "" }) };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(originHeader),
      body: JSON.stringify({
        ok: true,
        lead_id,
        deal_id: deal.id,
        deliverable_pdf_file_id: pdfUp.id,
        deliverable_csv_file_id: csvFileId || "",
        patched_csv: Boolean(CSV_FILE_ID_PROPERTY && csvFileId),
      }),
    };
  } catch (err) {
    console.error("upload-deliverables error:", err);
    return { statusCode: 500, headers: corsHeaders(originHeader), body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
