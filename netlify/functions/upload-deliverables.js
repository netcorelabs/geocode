// netlify/functions/upload-deliverables.js
export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://hubspotgate.netlify.app",
  ];

  function corsHeaders(origin) {
    const allowedOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    return {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
  }

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: "Method Not Allowed" };
  }

  // Hard block non-browser calls (prevents curl uploads into your portal)
  const origin = event.headers?.origin || "";
  if (!allowedOrigins.includes(origin)) {
    return { statusCode: 403, headers: corsHeaders(origin), body: "Forbidden" };
  }

  const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";
  if (!HS_TOKEN) return { statusCode: 500, headers: corsHeaders(origin), body: "Missing HUBSPOT_PRIVATE_APP_TOKEN" };

  const folderPath = process.env.HUBSPOT_FILES_FOLDER_PATH || "/lead_store_deliverables";

  async function readText(res){ try{return await res.text();}catch{return "";} }
  async function fetchJson(url, options={}){
    const res = await fetch(url, options);
    const text = await readText(res);
    let json=null; try{ json = text ? JSON.parse(text) : null; } catch { json=null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  const HS_AUTH = { Authorization: `Bearer ${HS_TOKEN}` };

  async function hsPostJson(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "POST",
      headers: { ...HS_AUTH, "Content-Type":"application/json" },
      body: JSON.stringify(body),
    });
  }
  async function hsPatchJson(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "PATCH",
      headers: { ...HS_AUTH, "Content-Type":"application/json" },
      body: JSON.stringify(body),
    });
  }

  async function findDealIdByLeadId(lead_id) {
    const r = await hsPostJson("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: String(lead_id) }] }],
      properties: ["lead_id"],
      limit: 1,
    });
    return r.ok && r.json?.results?.[0]?.id ? r.json.results[0].id : null;
  }

  async function uploadPrivateFile({ buffer, filename, mime }) {
    // Files upload uses multipart/form-data with options={"access":"PRIVATE"}. :contentReference[oaicite:10]{index=10}
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mime }), filename);
    form.append("fileName", filename);
    form.append("folderPath", folderPath);
    form.append("options", JSON.stringify({ access: "PRIVATE" }));

    const res = await fetch("https://api.hubapi.com/files/v3/files", {
      method: "POST",
      headers: { ...HS_AUTH }, // DO NOT set content-type; boundary is automatic
      body: form,
    });

    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }

    if (!res.ok) throw new Error(`File upload failed: ${res.status} ${text}`);
    return { fileId: String(json?.id || ""), access: json?.access || "", name: json?.name || "" };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const lead_id = String(body.lead_id || "").trim();
    const pdf_base64 = String(body.pdf_base64 || "").trim();
    const csv_text = String(body.csv_text || "").trim();

    if (!lead_id || !pdf_base64 || !csv_text) {
      return { statusCode: 400, headers: corsHeaders(origin), body: "Missing lead_id, pdf_base64, or csv_text" };
    }

    const dealId = await findDealIdByLeadId(lead_id);
    if (!dealId) return { statusCode: 404, headers: corsHeaders(origin), body: "Deal not found for lead_id" };

    const pdfBuf = Buffer.from(pdf_base64, "base64");
    const csvBuf = Buffer.from(csv_text, "utf8");

    const pdfName = `lead-${lead_id}.pdf`;
    const csvName = `lead-${lead_id}.csv`;

    const pdfUp = await uploadPrivateFile({ buffer: pdfBuf, filename: pdfName, mime: "application/pdf" });
    const csvUp = await uploadPrivateFile({ buffer: csvBuf, filename: csvName, mime: "text/csv" });

    // Store file IDs on Deal for later signed-url delivery
    await hsPatchJson(`/crm/v3/objects/deals/${dealId}`, {
      properties: {
        deliverable_pdf_file_id: pdfUp.fileId,
        deliverable_csv_file_id: csvUp.fileId,
      },
    });

    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({ ok: true, deal_id: dealId, pdf_file_id: pdfUp.fileId, csv_file_id: csvUp.fileId }),
    };
  } catch (err) {
    console.error("upload-deliverables error:", err);
    return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: err.message }) };
  }
}
