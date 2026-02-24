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

  // ✅ Destination folder env vars
  // IMPORTANT: HubSpot requires folderId OR folderPath as *top-level* multipart fields (not inside options).
  const FOLDER_ID_RAW = String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim();
  const FOLDER_PATH_RAW = String(process.env.HUBSPOT_FILES_FOLDER_PATH || "").trim();

  const HAS_FOLDER_ID = /^\d+$/.test(FOLDER_ID_RAW);
  const FOLDER_ID = HAS_FOLDER_ID ? FOLDER_ID_RAW : "";

  const FIXED_FOLDER_PATH = (() => {
    const p = (FOLDER_PATH_RAW || "").trim();
    if (!p) return "/";
    return p.startsWith("/") ? p : ("/" + p);
  })();

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

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  async function hsGet(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: hsAuth });
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

  async function dealPropertyExists(name) {
    const r = await hsGet(`/crm/v3/properties/deals/${encodeURIComponent(name)}`);
    return r.ok;
  }

  async function findDealByLeadId(leadId) {
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id", "deliverable_pdf_file_id", "deliverable_csv_file_id"],
      limit: 1,
    });
    return r.ok && r.json?.results?.[0] ? r.json.results[0] : null;
  }

  function b64ToBlob(b64, mime) {
    const buf = Buffer.from(String(b64 || ""), "base64");
    return new Blob([buf], { type: mime });
  }

  function buildUploadForm({ blob, filename, useFolderId, useFolderPath }) {
    const form = new FormData();

    // options is ONLY for file options (access, ttl). Folder goes in its own field.
    form.append("options", JSON.stringify({ access: "PRIVATE" }));
    form.append("fileName", filename);
    form.append("file", blob, filename);

    // ✅ REQUIRED: one of these MUST be present as its own multipart field
    if (useFolderId) form.append("folderId", useFolderId);
    else form.append("folderPath", useFolderPath || "/");

    return form;
  }

  async function uploadFileToHubSpot({ blob, filename }) {
    // Prefer folderId if present, else folderPath. If folderId fails, fallback to folderPath.
    const attempts = [];

    if (FOLDER_ID) {
      attempts.push({ folderId: FOLDER_ID, folderPath: "" });
    }
    attempts.push({ folderId: "", folderPath: FIXED_FOLDER_PATH || "/" });

    let last = null;

    for (const a of attempts) {
      const form = buildUploadForm({
        blob,
        filename,
        useFolderId: a.folderId,
        useFolderPath: a.folderPath,
      });

      const res = await fetch("https://api.hubapi.com/files/v3/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${HS_TOKEN}` },
        body: form,
      });

      const text = await res.text().catch(() => "");
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }

      last = {
        ok: res.ok,
        status: res.status,
        json,
        text,
        folder_field_used: a.folderId ? { folderId: a.folderId } : { folderPath: a.folderPath || "/" },
      };

      if (last.ok) return last;

      // If it failed for a reason OTHER than folder, don't retry.
      const msg = (json && (json.message || json.error)) ? String(json.message || json.error) : String(text || "");
      const isFolderError = msg.toLowerCase().includes("folderid") || msg.toLowerCase().includes("folderpath");
      if (!isFolderError) return last;
    }

    return last;
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const lead_id = String(body.lead_id || "").trim();
    const deal_id = String(body.deal_id || "").trim();

    const pdf_base64 = String(body.pdf_base64 || "").trim();
    const csv_text = String(body.csv_text || "");
    const csv_base64 = String(body.csv_base64 || "").trim();

    if (!pdf_base64) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing pdf_base64" }) };
    }
    if (!csv_text && !csv_base64) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing csv_text or csv_base64" }) };
    }
    if (!deal_id && !lead_id) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id or lead_id" }) };
    }

    // Ensure required deal properties exist
    const okPdf = await dealPropertyExists("deliverable_pdf_file_id");
    const okCsv = await dealPropertyExists("deliverable_csv_file_id");
    if (!okPdf || !okCsv) {
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "Missing Deal properties for deliverables",
          required: ["deliverable_pdf_file_id", "deliverable_csv_file_id"],
          fix: "Create these as Deal properties (single-line text) in the portal tied to HUBSPOT_PRIVATE_APP_TOKEN.",
        }),
      };
    }

    // Resolve dealId (prefer deal_id)
    let dealId = deal_id;
    if (!dealId) {
      const deal = await findDealByLeadId(lead_id);
      if (!deal?.id) {
        return { statusCode: 404, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal not found for lead_id", lead_id }) };
      }
      dealId = String(deal.id);
    }

    const pdfFilename = `home-secure-report-${dealId}.pdf`;
    const csvFilename = `home-secure-lead-${dealId}.csv`;

    const pdfBlob = b64ToBlob(pdf_base64, "application/pdf");
    const csvBlob = csv_base64 ? b64ToBlob(csv_base64, "text/csv") : new Blob([csv_text], { type: "text/csv" });

    const pdfUp = await uploadFileToHubSpot({ blob: pdfBlob, filename: pdfFilename });
    if (!pdfUp.ok || !pdfUp.json?.id) {
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "PDF upload failed",
          detail: pdfUp.text,
          folder_field_used: pdfUp.folder_field_used,
          env_seen: { HUBSPOT_FILES_FOLDER_ID: FOLDER_ID_RAW || "", HUBSPOT_FILES_FOLDER_PATH: FOLDER_PATH_RAW || "" },
        }),
      };
    }

    const csvUp = await uploadFileToHubSpot({ blob: csvBlob, filename: csvFilename });
    if (!csvUp.ok || !csvUp.json?.id) {
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "CSV upload failed",
          detail: csvUp.text,
          folder_field_used: csvUp.folder_field_used,
          env_seen: { HUBSPOT_FILES_FOLDER_ID: FOLDER_ID_RAW || "", HUBSPOT_FILES_FOLDER_PATH: FOLDER_PATH_RAW || "" },
        }),
      };
    }

    const pdfFileId = String(pdfUp.json.id);
    const csvFileId = String(csvUp.json.id);

    const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      properties: {
        deliverable_pdf_file_id: pdfFileId,
        deliverable_csv_file_id: csvFileId,
      },
    });

    if (!patched.ok) {
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Deal update failed (file ids)", detail: patched.text }),
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        lead_id: lead_id || null,
        deal_id: dealId,
        pdf_file_id: pdfFileId,
        csv_file_id: csvFileId,
        folder_field_used: pdfUp.folder_field_used,
        env_seen: { HUBSPOT_FILES_FOLDER_ID: FOLDER_ID_RAW || "", HUBSPOT_FILES_FOLDER_PATH: FOLDER_PATH_RAW || "" },
      }),
    };
  } catch (err) {
    console.error("upload-deliverables error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: String(err?.message || err) }),
    };
  }
}
