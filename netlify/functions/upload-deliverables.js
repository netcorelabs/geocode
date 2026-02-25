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

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Method Not Allowed" }) };

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };

  const FOLDER_ID_RAW = String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim();
  const FOLDER_PATH_RAW = String(process.env.HUBSPOT_FILES_FOLDER_PATH || "").trim();
  const FOLDER_ID = /^\d+$/.test(FOLDER_ID_RAW) ? FOLDER_ID_RAW : "";
  const FOLDER_PATH = (FOLDER_PATH_RAW || "/").startsWith("/") ? (FOLDER_PATH_RAW || "/") : ("/" + FOLDER_PATH_RAW);

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  // ---- HubSpot CRM helpers ----
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

  async function getPortalInfo() {
    const r = await hsGet("/integrations/v1/me");
    return r.ok ? (r.json || null) : null;
  }

  async function dealPropertyExists(name) {
    const r = await hsGet(`/crm/v3/properties/deals/${encodeURIComponent(name)}`);
    return r.ok;
  }

  async function findDealByLeadId(leadId) {
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id", "listing_status", "deliverable_pdf_file_id", "deliverable_csv_file_id"],
      limit: 1,
    });
    return r.ok && r.json?.results?.[0] ? r.json.results[0] : null;
  }

  async function readDealStatus(dealId) {
    const r = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=listing_status`);
    const s = String(r.json?.properties?.listing_status || "").trim();
    return s;
  }

  // ---- HubSpot Files helpers ----
  async function filesGet(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: hsAuth });
  }

  async function listFolderContents(folderId, limit = 100) {
    if(!folderId) return { ok:false, status:400, json:null, text:"Missing folderId" };
    return filesGet(`/files/v3/files?folderId=${encodeURIComponent(folderId)}&limit=${encodeURIComponent(String(limit))}`);
  }

  function b64ToBlob(b64, mime) {
    const buf = Buffer.from(String(b64 || ""), "base64");
    return new Blob([buf], { type: mime });
  }

  function buildUploadForm({ blob, filename, folderId, folderPath }) {
    const form = new FormData();
    form.append("options", JSON.stringify({ access: "PRIVATE" }));
    form.append("fileName", filename);
    form.append("file", blob, filename);

    // IMPORTANT: folderId/folderPath must be top-level multipart fields
    if (folderId) form.append("folderId", String(folderId));
    else form.append("folderPath", String(folderPath || "/"));

    return form;
  }

  async function uploadFileToHubSpot({ blob, filename }) {
    const attempts = [];
    if (FOLDER_ID) attempts.push({ folderId: FOLDER_ID, folderPath: "" });
    attempts.push({ folderId: "", folderPath: FOLDER_PATH || "/" });

    let last = null;
    for (const a of attempts) {
      const form = buildUploadForm({ blob, filename, folderId: a.folderId, folderPath: a.folderPath });
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

      const msg = String(json?.message || json?.error || text || "");
      const isFolderError = msg.toLowerCase().includes("folderid") || msg.toLowerCase().includes("folderpath");
      if (!isFolderError) return last;
    }

    return last;
  }

  function extractFileState(fileJson) {
    const stateRaw =
      fileJson?.state ??
      fileJson?.status ??
      fileJson?.processingState ??
      fileJson?.processing_state ??
      "";

    const state = String(stateRaw || "").trim();
    const isPublished =
      fileJson?.isPublished ??
      fileJson?.is_published ??
      fileJson?.published ??
      null;

    return { state, isPublished };
  }

  function computeListingStatus({ pdfMeta, csvMeta }) {
    const a = extractFileState(pdfMeta || {});
    const b = extractFileState(csvMeta || {});

    const states = [a.state, b.state].map(s => String(s || "").toUpperCase());
    const publishedFlags = [a.isPublished, b.isPublished];

    const looksReady =
      states.some(s => s === "ACTIVE" || s === "PUBLISHED") ||
      publishedFlags.some(v => v === true);

    const looksProcessing =
      states.some(s => s.includes("PROCESS") || s.includes("PENDING")) ||
      publishedFlags.some(v => v === false);

    if (looksReady) return "Deliverables Ready";
    if (looksProcessing) return "Deliverables Processing";

    // default safe
    return "Deliverables Processing";
  }

  function isFinalStatus(s) {
    const v = String(s || "").toLowerCase();
    return v.includes("paid") || v.includes("delivered") || v.includes("closed");
  }

  try {
    const portalInfo = await getPortalInfo();

    const body = JSON.parse(event.body || "{}");
    const lead_id = String(body.lead_id || "").trim();
    const deal_id = String(body.deal_id || "").trim();

    const pdf_base64 = String(body.pdf_base64 || "").trim();
    const csv_text = String(body.csv_text || "");
    const csv_base64 = String(body.csv_base64 || "").trim();

    if (!pdf_base64) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing pdf_base64" }) };
    if (!csv_text && !csv_base64) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing csv_text or csv_base64" }) };
    if (!deal_id && !lead_id) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id or lead_id" }) };

    // Make sure deliverable properties exist
    const okPdf = await dealPropertyExists("deliverable_pdf_file_id");
    const okCsv = await dealPropertyExists("deliverable_csv_file_id");
    const okListing = await dealPropertyExists("listing_status"); // used below
    if(!okPdf || !okCsv){
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "Missing Deal properties for deliverables",
          required: ["deliverable_pdf_file_id", "deliverable_csv_file_id"],
          portal_seen: portalInfo?.portalId || null
        })
      };
    }

    // Resolve dealId
    let resolvedDealId = deal_id;
    if(!resolvedDealId){
      const deal = await findDealByLeadId(lead_id);
      if(!deal?.id){
        return {
          statusCode: 404,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({ error: "Deal not found for lead_id", lead_id, portal_seen: portalInfo?.portalId || null })
        };
      }
      resolvedDealId = String(deal.id);
    }

    const pdfFilename = `home-secure-report-${resolvedDealId}.pdf`;
    const csvFilename = `home-secure-lead-${resolvedDealId}.csv`;

    const pdfBlob = b64ToBlob(pdf_base64, "application/pdf");
    const csvBlob = csv_base64 ? b64ToBlob(csv_base64, "text/csv") : new Blob([csv_text], { type: "text/csv" });

    // Upload both
    const pdfUp = await uploadFileToHubSpot({ blob: pdfBlob, filename: pdfFilename });
    if(!pdfUp.ok || !pdfUp.json?.id){
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "PDF upload failed",
          detail: pdfUp.text,
          folder_field_used: pdfUp.folder_field_used,
          env_seen: { HUBSPOT_FILES_FOLDER_ID: FOLDER_ID_RAW, HUBSPOT_FILES_FOLDER_PATH: FOLDER_PATH_RAW },
          portal_seen: portalInfo?.portalId || null
        })
      };
    }

    const csvUp = await uploadFileToHubSpot({ blob: csvBlob, filename: csvFilename });
    if(!csvUp.ok || !csvUp.json?.id){
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "CSV upload failed",
          detail: csvUp.text,
          folder_field_used: csvUp.folder_field_used,
          env_seen: { HUBSPOT_FILES_FOLDER_ID: FOLDER_ID_RAW, HUBSPOT_FILES_FOLDER_PATH: FOLDER_PATH_RAW },
          portal_seen: portalInfo?.portalId || null
        })
      };
    }

    const pdfFileId = String(pdfUp.json.id);
    const csvFileId = String(csvUp.json.id);

    // Write file IDs to deal
    const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(resolvedDealId)}`, {
      properties: {
        deliverable_pdf_file_id: pdfFileId,
        deliverable_csv_file_id: csvFileId,
      }
    });

    if(!patched.ok){
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Deal update failed (file ids)", detail: patched.text, portal_seen: portalInfo?.portalId || null })
      };
    }

    // ---- NEW: folder list + file meta check ----
    const folderList = FOLDER_ID ? await listFolderContents(FOLDER_ID, 100) : null;

    const pdfMetaRes = await filesGet(`/files/v3/files/${encodeURIComponent(pdfFileId)}`);
    const csvMetaRes = await filesGet(`/files/v3/files/${encodeURIComponent(csvFileId)}`);

    const pdfMeta = pdfMetaRes.ok ? pdfMetaRes.json : null;
    const csvMeta = csvMetaRes.ok ? csvMetaRes.json : null;

    // ---- NEW: compute + update listing_status ----
    const beforeStatus = okListing ? await readDealStatus(resolvedDealId) : "";
    const computed = computeListingStatus({ pdfMeta, csvMeta });

    let afterStatus = beforeStatus;
    let statusUpdated = false;

    if (okListing) {
      if (!isFinalStatus(beforeStatus)) {
        // Only update if not already Paid/Delivered/etc.
        const upd = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(resolvedDealId)}`, {
          properties: { listing_status: computed }
        });
        if (upd.ok) {
          afterStatus = computed;
          statusUpdated = true;
        }
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        lead_id: lead_id || null,
        deal_id: resolvedDealId,
        portal_seen: portalInfo?.portalId || null,

        // deliverable ids (these are what you store until payment)
        pdf_file_id: pdfFileId,
        csv_file_id: csvFileId,

        listing_status: {
          before: beforeStatus || null,
          computed,
          after: afterStatus || null,
          updated: statusUpdated,
          note: "Will not downgrade if status already includes Paid/Delivered/Closed."
        },

        folder_check: {
          folderId_env: FOLDER_ID_RAW || null,
          folderPath_env: FOLDER_PATH_RAW || null,
          folderList_ok: folderList ? folderList.ok : null,
          folderList_status: folderList ? folderList.status : null,
          // show first N only to keep response sane
          folderList_sample: folderList?.json?.results ? folderList.json.results.slice(0, 10) : null
        },

        file_meta: {
          pdf: { ok: pdfMetaRes.ok, state: pdfMeta ? extractFileState(pdfMeta) : null },
          csv: { ok: csvMetaRes.ok, state: csvMeta ? extractFileState(csvMeta) : null }
        }
      })
    };

  } catch (err) {
    console.error("upload-deliverables error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
