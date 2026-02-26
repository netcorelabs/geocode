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

  const folderId = /^\d+$/.test(rawFolderId) ? rawFolderId : "";
  const folderPath = !folderId && rawFolderPath && rawFolderPath.toLowerCase() !== "false" ? rawFolderPath : "";

  if (!folderId && !folderPath) {
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        error: "Missing folder config",
        detail: "Set HUBSPOT_FILES_FOLDER_ID (recommended) OR HUBSPOT_FILES_FOLDER_PATH (fallback).",
        env_seen: {
          HUBSPOT_FILES_FOLDER_ID: rawFolderId || null,
          HUBSPOT_FILES_FOLDER_PATH: rawFolderPath || null,
        },
      }),
    };
  }

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  function stripDataUrl(b64) {
    const s = String(b64 || "").trim();
    if (!s) return "";
    const idx = s.indexOf("base64,");
    return idx >= 0 ? s.slice(idx + 7).trim() : s;
  }

  function safeFileName(s) {
    return String(s || "")
      .replace(/[^a-z0-9_\-.]+/gi, "_")
      .replace(/_+/g, "_")
      .slice(0, 120);
  }

  function flatten(obj, prefix = "", out = {}) {
    if (!obj || typeof obj !== "object") return out;
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
      else out[key] = Array.isArray(v) ? JSON.stringify(v) : (v ?? "");
    }
    return out;
  }

  function payloadToCsvDump(payload) {
    const flat = flatten(payload || {});
    const lines = ["key,value"];
    for (const [k, v] of Object.entries(flat)) {
      const kk = String(k).replace(/"/g, '""');
      const vv = String(v).replace(/"/g, '""');
      lines.push(`"${kk}","${vv}"`);
    }
    return lines.join("\n");
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

  async function uploadFileToHubSpot({ bytes, filename, mimeType }) {
    const options = {
      access: "PRIVATE",
      overwrite: false,
      duplicateValidationStrategy: "NONE",
    };

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    form.append("options", JSON.stringify(options));
    if (folderId) form.append("folderId", String(folderId));
    else form.append("folderPath", String(folderPath));

    const res = await fetchJson("https://api.hubapi.com/files/v3/files", {
      method: "POST",
      headers: { ...hsAuth }, // DON'T set content-type for multipart
      body: form,
    });

    if (!res.ok) {
      throw new Error(`HubSpot file upload failed (${res.status}): ${res.text || JSON.stringify(res.json)}`);
    }

    const fileId = String(res.json?.id || "").trim();
    if (!fileId) throw new Error(`HubSpot upload missing file id: ${res.text || JSON.stringify(res.json)}`);
    return { fileId, raw: res.json };
  }

  async function createEngagementNoteWithAttachments({ dealId, leadId, fileIds }) {
    // Engagements NOTE with attachments is the most reliable for file attachments
    // Body format per engagements API docs.
    const now = Date.now();
    const noteBody =
      `Deliverables generated for Lead ID ${leadId}.\n\n` +
      `Attached File IDs: ${fileIds.join(", ")}\n` +
      `Folder: ${folderId ? `folderId=${folderId}` : `folderPath=${folderPath}`}`;

    const body = {
      engagement: {
        active: true,
        type: "NOTE",
        timestamp: now,
      },
      associations: {
        dealIds: [Number(dealId)],
      },
      metadata: {
        body: noteBody,
      },
      attachments: fileIds.map((id) => ({ id: Number(id) })),
    };

    const res = await fetchJson("https://api.hubapi.com/engagements/v1/engagements", {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Create engagement note failed (${res.status}): ${res.text || JSON.stringify(res.json)}`);
    }

    const engagementId =
      res.json?.engagement?.id ?? res.json?.engagement?.engagementId ?? res.json?.id ?? null;

    return String(engagementId || "").trim();
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const lead_id = String(body.lead_id || "").trim();
    const deal_id = String(body.deal_id || "").trim();
    const pdf_base64 = stripDataUrl(body.pdf_base64);
    const csv_text = String(body.csv_text || "");
    const payload = body.payload && typeof body.payload === "object" ? body.payload : null;

    if (!lead_id || !deal_id) {
      return {
        statusCode: 400,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Missing lead_id or deal_id" }),
      };
    }
    if (!pdf_base64) {
      return {
        statusCode: 400,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Missing pdf_base64" }),
      };
    }
    if (!csv_text) {
      return {
        statusCode: 400,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Missing csv_text" }),
      };
    }

    // mark processing (won’t break if property doesn't exist)
    await patchDealWithFallback(deal_id, { lead_status: "Deliverables Processing" });

    const pdfBytes = Buffer.from(pdf_base64, "base64");
    const csvBytes = Buffer.from(csv_text, "utf8");

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const pdfName = safeFileName(`HomeSecure_Report_${lead_id}_${ts}.pdf`);
    const csvName = safeFileName(`HomeSecure_Lead_${lead_id}_${ts}.csv`);

    // 1) Upload files
    const pdfUp = await uploadFileToHubSpot({ bytes: pdfBytes, filename: pdfName, mimeType: "application/pdf" });
    const csvUp = await uploadFileToHubSpot({ bytes: csvBytes, filename: csvName, mimeType: "text/csv" });
    const fileIds = [pdfUp.fileId, csvUp.fileId];

    // 2) Engagement NOTE with attachments + associated to deal
    const engagementNoteId = await createEngagementNoteWithAttachments({
      dealId: deal_id,
      leadId: lead_id,
      fileIds,
    });

    // 3) Patch deal with file IDs and payload dump into description
    const descDump = payload ? payloadToCsvDump(payload) : "";

    const dealPatch = await patchDealWithFallback(deal_id, {
      deliverable_pdf_file_id: pdfUp.fileId,
      deliverable_csv_file_id: csvUp.fileId,
      lead_status: "Deliverables Ready",
      description: descDump
        ? `Lead Payload (flattened CSV)\n\n${descDump}\n\nEngagement Note ID: ${engagementNoteId}\nPDF File ID: ${pdfUp.fileId}\nCSV File ID: ${csvUp.fileId}`
        : `Engagement Note ID: ${engagementNoteId}\nPDF File ID: ${pdfUp.fileId}\nCSV File ID: ${csvUp.fileId}`,
    });

    if (!dealPatch.ok) {
      return {
        statusCode: 200,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          ok: true,
          warning: "Deliverables uploaded and note created, but deal patch had warnings.",
          deal_patch_error: dealPatch.text || dealPatch.json || null,
          deal_id,
          lead_id,
          pdf_file_id: pdfUp.fileId,
          csv_file_id: csvUp.fileId,
          engagement_note_id: engagementNoteId,
          folder_used: folderId ? { folderId } : { folderPath },
        }),
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        deal_id,
        lead_id,
        pdf_file_id: pdfUp.fileId,
        csv_file_id: csvUp.fileId,
        engagement_note_id: engagementNoteId,
        folder_used: folderId ? { folderId } : { folderPath },
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
        },
        folder_choice: folderId ? "folderId" : "folderPath",
      }),
    };
  }
}
