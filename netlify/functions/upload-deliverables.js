// netlify/functions/upload-deliverables.js
// Uploads visitor PDF + CSV to HubSpot Files and stores IDs + PUBLIC URLs on the Deal.
// Uses PUBLIC_NOT_INDEXABLE access so the visitor can download without auth.
//
// Flow expectation (matches your hardened setup):
// ✅ HSRESULTS generates pdf_base64 + csv_text and calls this function ONCE per deal_id
// ✅ Thank You page only polls visitor-pdf-link for deliverable_pdf_url/csv_url
//
// Expected env:
//   HUBSPOT_PRIVATE_APP_TOKEN (required)
//   HUBSPOT_FILES_FOLDER_ID or HUBSPOT_FILES_FOLDER_PATH (recommended)
// Optional:
//   HUBSPOT_FILES_ACCESS = "PUBLIC_NOT_INDEXABLE" | "PRIVATE" | "PUBLIC_INDEXABLE" (default PUBLIC_NOT_INDEXABLE)
//   HUBSPOT_FILES_OVERWRITE = "true" | "false" (default false)

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

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) {
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }),
    };
  }

  const rawFolderId = String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim();
  const rawFolderPath = String(process.env.HUBSPOT_FILES_FOLDER_PATH || "").trim();

  // Prefer folderId if present, but we will auto-fallback if invalid.
  let folderId = rawFolderId || "";
  let folderPath = rawFolderPath || "/";

  const ACCESS = String(process.env.HUBSPOT_FILES_ACCESS || "PUBLIC_NOT_INDEXABLE").trim() || "PUBLIC_NOT_INDEXABLE";
  const OVERWRITE = String(process.env.HUBSPOT_FILES_OVERWRITE || "false").toLowerCase() === "true";

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  async function readText(res) {
    try { return await res.text(); } catch { return ""; }
  }
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

  function looksLikeBadFolderId(textOrJson) {
    const t = String(textOrJson || "");
    return /No folder exists with folderId|folderId/i.test(t);
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

    // Robustly collect missing property names (HubSpot errors sometimes return string or array)
    const badProps = new Set();
    for (const e of (r.json?.errors || [])) {
      if (e?.code !== "PROPERTY_DOESNT_EXIST") continue;
      const pn = e?.context?.propertyName;
      if (Array.isArray(pn)) pn.forEach((x) => x && badProps.add(String(x)));
      else if (typeof pn === "string" && pn.trim()) badProps.add(pn.trim());
    }

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

  async function getFileHostingUrl(fileId) {
    if (!fileId) return "";
    const r = await fetchJson(`https://api.hubapi.com/files/v3/files/${encodeURIComponent(fileId)}`, {
      method: "GET",
      headers: { ...hsAuth },
    });
    if (!r.ok) return "";
    return String(r.json?.defaultHostingUrl || r.json?.url || "").trim();
  }

  async function uploadFileToHubSpot({ bytes, filename, mimeType }) {
    const options = {
      access: ACCESS,
      overwrite: OVERWRITE,
      duplicateValidationStrategy: "NONE",
    };

    const makeForm = (useFolderId) => {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mimeType }), filename);
      form.append("options", JSON.stringify(options));
      if (useFolderId && folderId) form.append("folderId", String(folderId));
      else form.append("folderPath", String(folderPath || "/"));
      return form;
    };

    // Attempt with folderId if set, else folderPath
    let res = await fetchJson("https://api.hubapi.com/files/v3/files", {
      method: "POST",
      headers: { ...hsAuth }, // no Content-Type here
      body: makeForm(true),
    });

    // Auto-fallback if folderId is invalid
    if (!res.ok && folderId && res.status === 404 && looksLikeBadFolderId(res.text || JSON.stringify(res.json))) {
      // drop folderId and fallback to folderPath
      folderId = "";
      if (!folderPath) folderPath = "/";

      res = await fetchJson("https://api.hubapi.com/files/v3/files", {
        method: "POST",
        headers: { ...hsAuth },
        body: makeForm(false),
      });
    }

    if (!res.ok) {
      throw new Error(`HubSpot file upload failed (${res.status}): ${res.text || JSON.stringify(res.json)}`);
    }

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
      // HubSpot activities use semicolon-separated attachment IDs in hs_attachment_ids
      hs_attachment_ids: fileIds.join(";"),
    };

    const res = await fetchJson("https://api.hubapi.com/crm/v3/objects/notes", {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });

    if (!res.ok || !res.json?.id) {
      throw new Error(`Create note failed (${res.status}): ${res.text || JSON.stringify(res.json)}`);
    }
    return String(res.json.id);
  }

  // IMPORTANT: Associations v4 uses singular object types like "note" and "deal"
  async function associateDefault(fromType, fromId, toType, toId) {
    const url =
      `https://api.hubapi.com/crm/v4/objects/${encodeURIComponent(fromType)}/${encodeURIComponent(fromId)}` +
      `/associations/default/${encodeURIComponent(toType)}/${encodeURIComponent(toId)}`;

    const res = await fetchJson(url, { method: "PUT", headers: { ...hsAuth } });
    if (!res.ok) {
      throw new Error(`Associate ${fromType}→${toType} failed (${res.status}): ${res.text || JSON.stringify(res.json)}`);
    }
    return true;
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const lead_id = String(body.lead_id || "").trim();
    const deal_id = String(body.deal_id || "").trim();
    const email = String(body.email || "").trim();

    const pdf_base64 = stripDataUrl(body.pdf_base64);
    const csv_text = String(body.csv_text || "");
    const force = body.force === true;

    if (!lead_id || !deal_id) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing lead_id or deal_id" }) };
    }
    if (!email) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing email" }) };
    }
    if (!pdf_base64) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing pdf_base64" }) };
    }
    if (!csv_text) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing csv_text" }) };
    }

    // Reuse / recover if already present on deal
    const deal = await readDealProps(deal_id);
    const leadStatus = String(deal?.properties?.lead_status || "").trim();

    const existingPdfId = String(deal?.properties?.deliverable_pdf_file_id || "").trim();
    const existingCsvId = String(deal?.properties?.deliverable_csv_file_id || "").trim();
    let existingPdfUrl = String(deal?.properties?.deliverable_pdf_url || "").trim();
    let existingCsvUrl = String(deal?.properties?.deliverable_csv_url || "").trim();

    // If files exist but URLs are missing, recover from Files API and patch deal
    if ((existingPdfId && !existingPdfUrl) || (existingCsvId && !existingCsvUrl)) {
      const recoveredPdfUrl = existingPdfUrl || await getFileHostingUrl(existingPdfId);
      const recoveredCsvUrl = existingCsvUrl || await getFileHostingUrl(existingCsvId);

      if (recoveredPdfUrl) existingPdfUrl = recoveredPdfUrl;
      if (recoveredCsvUrl) existingCsvUrl = recoveredCsvUrl;

      if (existingPdfUrl) {
        await patchDealWithFallback(deal_id, {
          deliverable_pdf_url: existingPdfUrl,
          ...(existingCsvUrl ? { deliverable_csv_url: existingCsvUrl } : {}),
        });
      }
    }

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
          access: ACCESS,
        }),
      };
    }

    // If another invocation already started, avoid duplicate uploads
    if (!force && leadStatus === "Deliverables Processing") {
      return {
        statusCode: 202,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          ok: false,
          processing: true,
          deal_id,
          lead_id,
          message: "Deliverables are already processing for this deal. Retry shortly.",
          pdf_url: existingPdfUrl || null,
          csv_url: existingCsvUrl || null,
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

      // ✅ Correct v4 object types: note → deal
      if (noteId) await associateDefault("note", noteId, "deal", deal_id);
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
        overwrite: OVERWRITE,
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
          HUBSPOT_FILES_OVERWRITE: OVERWRITE ? "true" : "false",
        },
        folder_choice: folderId ? "folderId" : "folderPath",
      }),
    };
  }
}
