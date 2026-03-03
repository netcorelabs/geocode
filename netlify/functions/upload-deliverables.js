// netlify/functions/upload-deliverables.js
export async function handler(event) {
  /* =========================================================
     UPLOAD-DELIVERABLES (FULL DROP-IN)
     - Accepts: lead_id, deal_id, pdf_base64, csv_text, payload (optional), email (optional)
     - If deal_id missing/invalid: tries find by lead_id; if still missing: creates a Deal (safe, no "email" property)
     - Uploads PDF + CSV to HubSpot Files
     - Creates Note with attachments (best-effort) and associates to Deal (best-effort)
     - Patches Deal with deliverable_pdf_file_id + deliverable_csv_file_id (with fallback)
     - Returns { ok:true, deal_id, lead_id, pdf_file_id, csv_file_id, ... }

     IMPORTANT:
     - Ensure HubSpot Deal properties exist (recommended):
         deliverable_pdf_file_id, deliverable_csv_file_id, lead_id, lead_status
  ========================================================= */

  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "https://www.netcoreleads.com",
    "https://netcoreleads.com",
    "https://api.netcoreleads.com"
  ];

  function corsHeaders(originRaw) {
    const origin = String(originRaw || "").trim();
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
    return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
  }

  // Folder selection (prefer ID if provided)
  const rawFolderId = String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim();
  const rawFolderPath = String(process.env.HUBSPOT_FILES_FOLDER_PATH || "").trim();
  const folderId = rawFolderId || "";
  const folderPath = rawFolderPath || "/Home Secure Calculator";

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
    const s = String(b64 || "");
    const i = s.indexOf("base64,");
    return i >= 0 ? s.slice(i + 7).trim() : s.trim();
  }

  function safeFileName(name) {
    return String(name || "file")
      .replace(/[^\w\-(). ]+/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 160);
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

  async function hsGet(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: { ...hsAuth } });
  }
  async function hsPost(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function hsPatch(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "PATCH",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function patchDealWithFallback(dealId, properties) {
    const attempt = async (props) =>
      hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: props });

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

  async function readDealById(dealId) {
    const r = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=lead_id,deliverable_pdf_file_id,deliverable_csv_file_id,lead_status,description,dealname`);
    return (r.ok && r.json?.id) ? r.json : null;
  }

  async function findDealByLeadId(leadId) {
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id", "deliverable_pdf_file_id", "deliverable_csv_file_id", "dealname"],
      limit: 1,
    });
    return (r.ok && r.json?.results?.[0]?.id) ? String(r.json.results[0].id) : "";
  }

  async function createDealSafe({ lead_id, dealname }) {
    // Deals require dealname; DO NOT send "email" as a deal property.
    // Try with lead_id; if that property doesn't exist, retry without it.
    const r1 = await hsPost("/crm/v3/objects/deals", { properties: { dealname, lead_id } });
    if (r1.ok && r1.json?.id) return String(r1.json.id);

    // If lead_id is not a valid deal property, retry with only dealname
    const r2 = await hsPost("/crm/v3/objects/deals", { properties: { dealname } });
    if (r2.ok && r2.json?.id) return String(r2.json.id);

    throw new Error(`Create deal failed (${r2.status || r1.status}): ${r2.text || r1.text || "Unknown error"}`);
  }

  async function uploadFileToHubSpot({ bytes, filename, mimeType }) {
    const options = { access: "PRIVATE", overwrite: false, duplicateValidationStrategy: "NONE" };

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    form.append("options", JSON.stringify(options));
    if (folderId) form.append("folderId", String(folderId));
    else form.append("folderPath", String(folderPath));

    const res = await fetchJson("https://api.hubapi.com/files/v3/files", {
      method: "POST",
      headers: { ...hsAuth }, // do NOT set Content-Type (boundary)
      body: form,
    });

    if (!res.ok) {
      throw new Error(`HubSpot file upload failed (${res.status}): ${res.text || JSON.stringify(res.json)}`);
    }

    const fileId = String(res.json?.id || "").trim();
    if (!fileId) throw new Error(`HubSpot upload missing file id: ${res.text || JSON.stringify(res.json)}`);
    return { fileId, raw: res.json };
  }

  async function createNoteWithAttachments({ leadId, fileIds }) {
    const now = Date.now();
    const props = {
      hs_timestamp: now,
      hs_note_body:
        `Deliverables generated for Lead ID ${leadId}.\n\n` +
        `Attached file IDs: ${fileIds.join(", ")}\n` +
        `Folder: ${folderId ? `folderId=${folderId}` : `folderPath=${folderPath}`}`,
      // MUST be semicolon-delimited
      hs_attachment_ids: fileIds.join(";"),
    };

    const res = await hsPost("/crm/v3/objects/notes", { properties: props });
    if (!res.ok || !res.json?.id) {
      throw new Error(`Create note failed (${res.status}): ${res.text || JSON.stringify(res.json)}`);
    }
    return String(res.json.id);
  }

  async function getNoteDealAssociationTypeId() {
    const res = await fetchJson("https://api.hubapi.com/crm/v4/associations/notes/deals/labels", {
      method: "GET",
      headers: { ...hsAuth },
    });
    if (!res.ok) return null;
    const results = res.json?.results || [];
    const pick = results.find((x) => x.associationCategory === "HUBSPOT_DEFINED") || results[0];
    return pick?.associationTypeId ? Number(pick.associationTypeId) : null;
  }

  async function associateNoteToDeal({ noteId, dealId, associationTypeId }) {
    const url =
      `https://api.hubapi.com/crm/v3/objects/notes/${encodeURIComponent(noteId)}` +
      `/associations/deals/${encodeURIComponent(dealId)}/${encodeURIComponent(String(associationTypeId))}`;

    const res = await fetchJson(url, { method: "PUT", headers: { ...hsAuth } });
    if (!res.ok) throw new Error(`Associate note→deal failed (${res.status}): ${res.text || JSON.stringify(res.json)}`);
    return true;
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const lead_id = String(body.lead_id || "").trim();
    let deal_id = String(body.deal_id || "").trim();
    const email = String(body.email || "").trim(); // optional
    const pdf_base64 = stripDataUrl(body.pdf_base64);
    const csv_text = String(body.csv_text || "");
    const payload = body.payload && typeof body.payload === "object" ? body.payload : null;

    if (!lead_id) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing lead_id" }) };
    }
    if (!pdf_base64) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing pdf_base64" }) };
    }
    if (!csv_text) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing csv_text" }) };
    }

    // 1) Ensure we have a valid deal
    let deal = null;

    if (deal_id) deal = await readDealById(deal_id);
    if (!deal) {
      const found = await findDealByLeadId(lead_id);
      if (found) {
        deal_id = found;
        deal = await readDealById(deal_id);
      }
    }

    if (!deal) {
      const dealname = `HSC Lead ${lead_id}`;
      deal_id = await createDealSafe({ lead_id, dealname });
      deal = await readDealById(deal_id);
    }

    // Idempotent reuse
    const existingPdf = String(deal?.properties?.deliverable_pdf_file_id || "").trim();
    const existingCsv = String(deal?.properties?.deliverable_csv_file_id || "").trim();
    if (existingPdf && existingCsv) {
      return {
        statusCode: 200,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          ok: true,
          reused: true,
          deal_id,
          lead_id,
          pdf_file_id: existingPdf,
          csv_file_id: existingCsv,
          folder_used: folderId ? { folderId } : { folderPath },
        }),
      };
    }

    // status best-effort
    await patchDealWithFallback(deal_id, { lead_status: "Deliverables Processing" });

    const pdfBytes = Buffer.from(pdf_base64, "base64");
    const csvBytes = Buffer.from(csv_text, "utf8");

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const pdfName = safeFileName(`HomeSecure_Report_${lead_id}_${ts}.pdf`);
    const csvName = safeFileName(`HomeSecure_Lead_${lead_id}_${ts}.csv`);

    // 2) Upload files
    const pdfUp = await uploadFileToHubSpot({ bytes: pdfBytes, filename: pdfName, mimeType: "application/pdf" });
    const csvUp = await uploadFileToHubSpot({ bytes: csvBytes, filename: csvName, mimeType: "text/csv" });

    // 3) Note (best-effort)
    let noteId = "";
    let assocTypeId = null;
    let noteAssociated = false;
    let warning = null;

    try {
      noteId = await createNoteWithAttachments({ leadId: lead_id, fileIds: [pdfUp.fileId, csvUp.fileId] });
      assocTypeId = await getNoteDealAssociationTypeId();
      if (noteId && assocTypeId) {
        await associateNoteToDeal({ noteId, dealId: deal_id, associationTypeId: assocTypeId });
        noteAssociated = true;
      } else {
        warning = "Note created but note→deal associationTypeId not found.";
      }
    } catch (e) {
      warning = String(e?.message || e);
    }

    // 4) Patch deal with file IDs + payload dump
    const descDump = payload ? payloadToCsvDump(payload) : "";
    const desc =
      (descDump ? `Lead Payload (flattened CSV)\n\n${descDump}\n\n` : "") +
      `PDF File ID: ${pdfUp.fileId}\nCSV File ID: ${csvUp.fileId}\n` +
      (email ? `Email: ${email}\n` : "") +
      (noteId ? `Note ID: ${noteId}\n` : "");

    const patch = await patchDealWithFallback(deal_id, {
      deliverable_pdf_file_id: pdfUp.fileId,
      deliverable_csv_file_id: csvUp.fileId,
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
        note_id: noteId || null,
        note_associated: noteAssociated,
        associationTypeId: assocTypeId,
        deal_patch_ok: patch.ok,
        deal_patch_status: patch.status,
        warning,
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
          HUBSPOT_FILES_FOLDER_ID: String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim() || null,
          HUBSPOT_FILES_FOLDER_PATH: String(process.env.HUBSPOT_FILES_FOLDER_PATH || "").trim() || null,
        },
        folder_choice: String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim() ? "folderId" : "folderPath",
      }),
    };
  }
}
