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
    return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
  }

  // Folder config
  const FOLDER_ID = String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim();     // e.g. "534110850311"
  const FOLDER_PATH = String(process.env.HUBSPOT_FILES_FOLDER_PATH || "").trim(); // e.g. "/lead_store_deliverables/"
  // HubSpot requires folderId OR folderPath as a separate multipart field. :contentReference[oaicite:1]{index=1}

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
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
      properties: ["lead_id", "deliverable_pdf_file_id", "deliverable_csv_file_id", "listing_status"],
      limit: 1,
    });
    return r.ok && r.json?.results?.[0] ? r.json.results[0] : null;
  }

  async function readDealById(dealId) {
    const r = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=lead_id,deliverable_pdf_file_id,deliverable_csv_file_id,listing_status`);
    if (!r.ok || !r.json?.id) return null;
    return r.json;
  }

  function b64ToBlob(b64, mime) {
    const buf = Buffer.from(String(b64 || ""), "base64");
    return new Blob([buf], { type: mime });
  }

  async function uploadFileToHubSpot({ blob, filename }) {
    const form = new FormData();

    // REQUIRED: options is a JSON string field
    form.append("options", JSON.stringify({
      access: "PRIVATE",
      overwrite: false,
      duplicateValidationStrategy: "NONE",
    }));

    // REQUIRED: folderId OR folderPath must be provided as its own form field. :contentReference[oaicite:2]{index=2}
    if (FOLDER_ID) form.append("folderId", FOLDER_ID);
    else if (FOLDER_PATH) form.append("folderPath", FOLDER_PATH);

    form.append("fileName", filename);
    form.append("file", blob, filename);

    const res = await fetch("https://api.hubapi.com/files/v3/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${HS_TOKEN}` },
      body: form,
    });

    const text = await res.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  async function searchFilesByIdsInFolder(fileIds) {
    // Use the Files search endpoint so we can confirm folder + access. :contentReference[oaicite:3]{index=3}
    const ids = (fileIds || []).filter(Boolean).map(String);
    if (!ids.length) return { ok: false, files: [], detail: "No file IDs" };

    const u = new URL("https://api.hubapi.com/files/v3/files/search");
    if (FOLDER_ID) u.searchParams.append("parentFolderIds", FOLDER_ID);
    // Private files will have allowsAnonymousAccess=false; we want to include those.
    u.searchParams.append("allowsAnonymousAccess", "false");
    u.searchParams.append("limit", "200");
    ids.forEach((id) => u.searchParams.append("ids", id));

    const r = await fetchJson(u.toString(), { method: "GET", headers: hsAuth });
    const results = Array.isArray(r.json?.results) ? r.json.results : [];
    return { ok: r.ok, files: results, raw: r };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const lead_id = String(body.lead_id || "").trim();
    const deal_id = String(body.deal_id || "").trim();

    const pdf_base64 = String(body.pdf_base64 || "").trim();
    const csv_text = String(body.csv_text || "");
    const csv_base64 = String(body.csv_base64 || "").trim();

    if (!deal_id && !lead_id) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id or lead_id" }) };
    }
    if (!pdf_base64) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing pdf_base64" }) };
    }
    if (!csv_text && !csv_base64) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing csv_text or csv_base64" }) };
    }

    // Ensure required deal properties exist
    const okLead = await dealPropertyExists("lead_id");
    const okPdf = await dealPropertyExists("deliverable_pdf_file_id");
    const okCsv = await dealPropertyExists("deliverable_csv_file_id");
    if (!okLead || !okPdf || !okCsv) {
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "Missing required Deal properties",
          required: ["lead_id", "deliverable_pdf_file_id", "deliverable_csv_file_id"],
        }),
      };
    }

    // Find deal (prefer deal_id to avoid indexing delay)
    let deal = null;
    if (deal_id) {
      deal = await readDealById(deal_id);
      if (!deal?.id) {
        return { statusCode: 404, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal not found for deal_id", deal_id }) };
      }
    } else {
      deal = await findDealByLeadId(lead_id);
      if (!deal?.id) {
        return { statusCode: 404, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal not found for lead_id", lead_id }) };
      }
    }

    const dealId = String(deal.id);
    const resolvedLeadId = String(deal.properties?.lead_id || lead_id || "").trim();

    // Build blobs
    const pdfBlob = b64ToBlob(pdf_base64, "application/pdf");
    const csvBlob = csv_base64
      ? b64ToBlob(csv_base64, "text/csv")
      : new Blob([csv_text], { type: "text/csv" });

    // File names
    const pdfFilename = `home-secure-report-${dealId}.pdf`;
    const csvFilename = `home-secure-lead-${dealId}.csv`;

    // Upload PDF
    const pdfUp = await uploadFileToHubSpot({ blob: pdfBlob, filename: pdfFilename });
    if (!pdfUp.ok || !pdfUp.json?.id) {
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "PDF upload failed",
          detail: pdfUp.text,
          env_seen: { HUBSPOT_FILES_FOLDER_ID: FOLDER_ID, HUBSPOT_FILES_FOLDER_PATH: FOLDER_PATH },
        }),
      };
    }

    // Upload CSV
    const csvUp = await uploadFileToHubSpot({ blob: csvBlob, filename: csvFilename });
    if (!csvUp.ok || !csvUp.json?.id) {
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "CSV upload failed",
          detail: csvUp.text,
          env_seen: { HUBSPOT_FILES_FOLDER_ID: FOLDER_ID, HUBSPOT_FILES_FOLDER_PATH: FOLDER_PATH },
        }),
      };
    }

    const pdfFileId = String(pdfUp.json.id);
    const csvFileId = String(csvUp.json.id);

    // Verify they exist in folder (helps you debug “why can’t I see them”)
    const verify = await searchFilesByIdsInFolder([pdfFileId, csvFileId]);

    // Update deal properties
    const listingStatusExists = await dealPropertyExists("listing_status"); // you said you want to use this
    const pdfPathExists = await dealPropertyExists("deliverable_pdf_path");
    const csvPathExists = await dealPropertyExists("deliverable_csv_path");

    const props = {
      deliverable_pdf_file_id: pdfFileId,
      deliverable_csv_file_id: csvFileId,
    };

    if (listingStatusExists) {
      // This is your “until payment completes” marker
      props.listing_status = "DELIVERABLES_UPLOADED_PRIVATE";
    }

    if (pdfPathExists && pdfUp.json?.path) props.deliverable_pdf_path = String(pdfUp.json.path);
    if (csvPathExists && csvUp.json?.path) props.deliverable_csv_path = String(csvUp.json.path);

    const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: props });
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
        lead_id: resolvedLeadId,
        deal_id: dealId,
        pdf_file_id: pdfFileId,
        csv_file_id: csvFileId,
        folder: { folderId: FOLDER_ID || null, folderPath: FOLDER_PATH || null },
        verify: {
          ok: verify.ok,
          found: (verify.files || []).map(f => ({
            id: f.id,
            name: f.name,
            path: f.path,
            parentFolderId: f.parentFolderId,
            access: f.access,
            allowsAnonymousAccess: f.allowsAnonymousAccess,
          })),
        },
      }),
    };
  } catch (err) {
    console.error("upload-deliverables error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
