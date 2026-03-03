// netlify/functions/upload-deliverables.js
// Uploads visitor PDF + CSV to HubSpot Files and stores IDs + PUBLIC URLs on the Deal.
// Uses PUBLIC_NOT_INDEXABLE access so the visitor can download without auth.
//
// Expected env:
//   HUBSPOT_PRIVATE_APP_TOKEN (required)
//   HUBSPOT_FILES_FOLDER_ID or HUBSPOT_FILES_FOLDER_PATH (recommended)
// Optional:
//   HUBSPOT_FILES_ACCESS = "PUBLIC_NOT_INDEXABLE" | "PRIVATE"  (default PUBLIC_NOT_INDEXABLE)

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
  if (!HS_TOKEN) return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };

  const rawFolderId = String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim();
  const rawFolderPath = String(process.env.HUBSPOT_FILES_FOLDER_PATH || "").trim();
  const folderId = rawFolderId || "";
  const folderPath = rawFolderPath || "/";

  const ACCESS = String(process.env.HUBSPOT_FILES_ACCESS || "PUBLIC_NOT_INDEXABLE").trim() || "PUBLIC_NOT_INDEXABLE";

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  function stripDataUrl(s) {
    const str = String(s || "");
    const idx = str.indexOf("base64,");
    return idx >= 0 ? str.slice(idx + 7).trim() : str.trim();
  }

  function safeFileName(name) {
    return String(name || "file")
      .replace(/[^\w.\-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 180);
  }

  async function patchDealWithFallback(dealId, properties) {
    const attempt = async (props) =>
      fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
        method: "PATCH",
        headers: { ...hsAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: props }),
      });

    let r = await attempt(properties);
    if (r.ok) return r;

    const badProps = new Set(
      (r.json?.errors || [])
        .filter((e) => e.code === "PROPERTY_DOESNT_EXIST")
        .flatMap((e) => e.context?.propertyName || [])
    );

    if (badProps.size) {
      const filtered = Object.fromEntries(Object.entries(properties).filter(([k]) => !badProps.has(k)));
      if (Object.keys(filtered).length) {
        r = await attempt(filtered);
        if (r.ok) return r;
      }
    }
    return r;
  }

  async function readDealProps(dealId) {
    const r = await fetchJson(
      `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}` +
      `?properties=deliverable_pdf_file_id,deliverable_csv_file_id,deliverable_pdf_url,deliverable_csv_url,lead_status,description`,
      { method: "GET", headers: { ...hsAuth } }
    );
    if (!r.ok) return null;
    return r.json;
  }

  async function uploadFileToHubSpot({ bytes, filename, mimeType }) {
    const options = { access: ACCESS, overwrite: false, duplicateValidationStrategy: "NONE" };

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    form.append("options", JSON.stringify(options));
    if (folderId) form.append("folderId", String(folderId));
    else form.append("folderPath", String(folderPath));

    const res = await fetchJson("https://api.hubapi.com/files/v3/files", {
      method: "POST",
      headers: { ...hsAuth }, // no Content-Type here
      body: form,
    });

    if (!res.ok) throw new Error(`HubSpot file upload failed (${res.status}): ${res.text || JSON.stringify(res.json)}`);

    const fileId = String(res.json?.id || "").trim();
    if (!fileId) throw new Error(`HubSpot upload missing file id: ${res.text || JSON.stringify(res.json)}`);

    const url = String(res.json?.defaultHostingUrl || res.json?.url || "").trim();
    return { fileId, url, raw: res.json };
  }

  async function createNoteWithAttachments({ leadId, fileIds, pdfUrl, csvUrl }) {
    const now = Date.now();
    const props = {
      hs_timestamp: now,
      hs_note_body:
        `Deliverables generated for Lead ID ${leadId}.\n\n` +
        `PDF: ${pdfUrl || "(url pending)"}\n` +
        `CSV: ${csvUrl || "(url pending)"}\n\n` +
        `Attached file IDs: ${fileIds.join(", ")}\n` +
        `Folder: ${folderId ? `folderId=${folderId}` : `folderPath=${folderPath}`}`,
      hs_attachment_ids: fileIds.join(";"), // IMPORTANT: semicolon-separated
    };

    const res = await fetchJson("https://api.hubapi.com/crm/v3/objects/notes", {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });

    if (!res.ok || !res.json?.id) throw new Error(`Create note failed (${res.status}): ${res.text || JSON.stringify(res.json)}`);
    return String(res.json.id);
  }

  async function associateDefault(fromType, fromId, toType, toId) {
    const url =
      `https://api.hubapi.com/crm/v4/objects/${encodeURIComponent(fromType)}/${encodeURIComponent(fromId)}` +
      `/associations/default/${encodeURIComponent(toType)}/${encodeURIComponent(toId)}`;

    const res = await fetchJson(url, { method: "PUT", headers: { ...hsAuth } });
    if (!res.ok) throw new Error(`Associate ${fromType}→${toType} failed (${res.status}): ${res.text || JSON.stringify(res.json)}`);
    return true;
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const lead_id = String(body.lead_id || "").trim();
    const deal_id = String(body.deal_id || "").trim();
    const email = String(body.email || "").trim();

    const pdf_base64 = stripDataUrl(body.pdf_base64);
    const csv_text = String(body.csv_text || "");
    const payload = body.payload && typeof body.payload === "object" ? body.payload : null;

    if (!lead_id || !deal_id) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing lead_id or deal_id" }) };
    if (!email) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing email" }) };
    if (!pdf_base64) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing pdf_base64" }) };
    if (!csv_text) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing csv_text" }) };

    // Reuse if already present
    const deal = await readDealProps(deal_id);
    const existingPdfId = String(deal?.properties?.deliverable_pdf_file_id || "").trim();
    const existingCsvId = String(deal?.properties?.deliverable_csv_file_id || "").trim();
    const existingPdfUrl = String(deal?.properties?.deliverable_pdf_url || "").trim();
    const existingCsvUrl = String(deal?.properties?.deliverable_csv_url || "").trim();

    if (existingPdfId && existingCsvId && existingPdfUrl) {
      return {
        statusCode: 200,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          ok: true,
          reused: true,
          deal_id,
          lead_id,
          pdf_file_id: existingPdfId,
          csv_file_id: existingCsvId,
          pdf_url: existingPdfUrl,
          csv_url: existingCsvUrl || null,
          folder_used: folderId ? { folderId } : { folderPath },
        }),
      };
    }

    await patchDealWithFallback(deal_id, { lead_status: "Deliverables Processing" });

    const pdfBytes = Buffer.from(pdf_base64, "base64");
    const csvBytes = Buffer.from(csv_text, "utf8");

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const pdfName = safeFileName(`HomeSecure_Report_${lead_id}_${ts}.pdf`);
    const csvName = safeFileName(`HomeSecure_Lead_${lead_id}_${ts}.csv`);

    const pdfUp = await uploadFileToHubSpot({ bytes: pdfBytes, filename: pdfName, mimeType: "application/pdf" });
    const csvUp = await uploadFileToHubSpot({ bytes: csvBytes, filename: csvName, mimeType: "text/csv" });

    const fileIds = [pdfUp.fileId, csvUp.fileId];

    let noteId = "";
    let noteWarning = null;
    try {
      noteId = await createNoteWithAttachments({ leadId: lead_id, fileIds, pdfUrl: pdfUp.url, csvUrl: csvUp.url });
      if (noteId) await associateDefault("notes", noteId, "deals", deal_id);
    } catch (e) {
      noteWarning = String(e?.message || e);
    }

    const desc =
      `Visitor PDF URL: ${pdfUp.url}\nVisitor CSV URL: ${csvUp.url}\n` +
      `PDF File ID: ${pdfUp.fileId}\nCSV File ID: ${csvUp.fileId}\n` +
      (noteId ? `Note ID: ${noteId}\n` : "");

    const patch = await patchDealWithFallback(deal_id, {
      deliverable_pdf_file_id: pdfUp.fileId,
      deliverable_csv_file_id: csvUp.fileId,
      deliverable_pdf_url: pdfUp.url,
      deliverable_csv_url: csvUp.url,
      lead_status: "Deliverables Ready",
      description: desc,
    });

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        deal_id,
        lead_id,
        pdf_file_id: pdfUp.fileId,
        csv_file_id: csvUp.fileId,
        pdf_url: pdfUp.url,
        csv_url: csvUp.url,
        note_id: noteId || null,
        deal_patch_ok: patch.ok,
        deal_patch_status: patch.status,
        warning: noteWarning,
        folder_used: folderId ? { folderId } : { folderPath },
        access: ACCESS,
      }),
    };
  } catch (err) {
    console.error("upload-deliverables error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        error: "upload-deliverables failed",
        detail: String(err?.message || err),
        env_seen: {
          HUBSPOT_FILES_FOLDER_ID: rawFolderId || null,
          HUBSPOT_FILES_FOLDER_PATH: rawFolderPath || null,
          HUBSPOT_FILES_ACCESS: ACCESS,
        },
        folder_choice: folderId ? "folderId" : "folderPath",
      }),
    };
  }
}
