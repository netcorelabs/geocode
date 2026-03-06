// netlify/functions/upload-deliverables.js
// Uploads visitor PDF + CSV to HubSpot Files and stores IDs + PUBLIC URLs on the Deal.
// Uses PUBLIC_NOT_INDEXABLE access so the visitor can download without auth.
//
// ✅ HARDENED FIX (v2)
// - If PATCH/GET Deal returns 404 (resource not found), automatically attempts to RECOVER the deal_id by lead_id
//   using the Deals Search API (query + optional lead_id EQ filter).
// - Returns clear diagnostics (portalId, recovered_deal_id, deal_lookup_attempts) to quickly spot portal/token mismatch.
// - Treats deal association / note creation as best-effort (won’t block deliverables being saved on the deal).
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

  // -------- Portal Meta (helps debug token/portal mismatch)
  async function getPortalMeta() {
    const r = await fetchJson("https://api.hubapi.com/integrations/v1/me", {
      method: "GET",
      headers: { ...hsAuth, "Accept": "application/json" }
    });
    if (!r.ok) return null;
    return r.json || null; // contains portalId, user, etc.
  }

  // -------- Deal Recovery (when PATCH/GET Deal returns 404)
  async function searchDealByLeadId(leadId) {
    const attempts = [];
    const url = "https://api.hubapi.com/crm/v3/objects/deals/search";

    const postSearch = async (payload) => {
      const r = await fetchJson(url, {
        method: "POST",
        headers: { ...hsAuth, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      attempts.push({ request: payload, status: r.status, ok: r.ok });
      return r;
    };

    // Attempt 1: filter on custom property "lead_id" == leadId (if it exists)
    let r = await postSearch({
      filterGroups: [{
        filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }]
      }],
      properties: ["dealname", "lead_id", "hs_object_id"],
      limit: 5,
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }]
    });

    if (r.ok && Array.isArray(r.json?.results) && r.json.results.length) {
      return { dealId: String(r.json.results[0].id || "").trim(), attempts };
    }

    // Attempt 2: broad query search
    r = await postSearch({
      query: leadId,
      properties: ["dealname", "hs_object_id"],
      limit: 5
    });

    if (r.ok && Array.isArray(r.json?.results) && r.json.results.length) {
      return { dealId: String(r.json.results[0].id || "").trim(), attempts };
    }

    return { dealId: "", attempts };
  }

  async function readDealProps(dealId) {
    const r = await fetchJson(
      `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}` +
        `?properties=deliverable_pdf_file_id,deliverable_csv_file_id,deliverable_pdf_url,deliverable_csv_url,lead_status,description,dealname`,
      { method: "GET", headers: { ...hsAuth } }
    );
    if (!r.ok) return { ok:false, status:r.status, json:r.json, text:r.text };
    return { ok:true, status:r.status, json:r.json, text:r.text };
  }

  async function patchDeal(dealId, properties) {
    return fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      method: "PATCH",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ properties }),
    });
  }

  async function patchDealWithFallback(dealId, properties) {
    const attempt = async (id, props) => patchDeal(id, props);

    let r = await attempt(dealId, properties);
    if (r.ok) return { ...r, deal_id: dealId, recovered: false };

    // If deal not found, try recover by lead_id
    if (r.status === 404) {
      const leadIdForRecovery = String(properties?.lead_id || "").trim();
      if (leadIdForRecovery) {
        const rec = await searchDealByLeadId(leadIdForRecovery);
        if (rec.dealId) {
          const r2 = await attempt(rec.dealId, properties);
          if (r2.ok) return { ...r2, deal_id: rec.dealId, recovered: true, deal_lookup_attempts: rec.attempts };
          r = r2;
        }
      }
    }

    // Filter missing properties if needed
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
        const r3 = await attempt(dealId, filtered);
        if (r3.ok) return { ...r3, deal_id: dealId, recovered: false, filtered_missing_props: Array.from(badProps) };
        return { ...r3, deal_id: dealId, recovered: false, filtered_missing_props: Array.from(badProps) };
      }
    }

    return { ...r, deal_id: dealId, recovered: false };
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

    let res = await fetchJson("https://api.hubapi.com/files/v3/files", {
      method: "POST",
      headers: { ...hsAuth },
      body: makeForm(true),
    });

    if (!res.ok && folderId && res.status === 404 && looksLikeBadFolderId(res.text || JSON.stringify(res.json))) {
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
        `Deliverables generated for Lead ID ${leadId}.

` +
        `PDF: ${pdfUrl || "(url pending)"}
` +
        `CSV: ${csvUrl || "(url pending)"}

` +
        `Attached file IDs: ${fileIds.join(", ")}
` +
        `Folder: ${folderId ? `folderId=${folderId}` : `folderPath=${folderPath}`}`,
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
    const portalMeta = await getPortalMeta();

    const body = JSON.parse(event.body || "{}");
    const lead_id = String(body.lead_id || "").trim();
    let deal_id = String(body.deal_id || "").trim();
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

    // Confirm deal exists; if not, recover by lead_id
    let recovered_deal_id = "";
    let deal_lookup_attempts = [];

    let dealRead = await readDealProps(deal_id);
    if (!dealRead.ok && dealRead.status === 404) {
      const rec = await searchDealByLeadId(lead_id);
      deal_lookup_attempts = rec.attempts || [];
      if (rec.dealId) {
        recovered_deal_id = rec.dealId;
        deal_id = rec.dealId;
        dealRead = await readDealProps(deal_id);
      }
    }

    if (!dealRead.ok) {
      return {
        statusCode: dealRead.status === 404 ? 404 : 502,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "deal_not_found_or_unreadable",
          message:
            dealRead.status === 404
              ? "Deal not found in this HubSpot portal for the current HUBSPOT_PRIVATE_APP_TOKEN. This usually means a portal/token mismatch (deal created in another portal)."
              : "Failed to read deal from HubSpot.",
          status: dealRead.status,
          lead_id,
          deal_id,
          recovered_deal_id: recovered_deal_id || null,
          deal_lookup_attempts,
          portal: portalMeta ? { portalId: portalMeta.portalId, user: portalMeta.user } : null,
          hubspot_detail: dealRead.json || dealRead.text || null
        }),
      };
    }

    const deal = dealRead.json;
    const leadStatus = String(deal?.properties?.lead_status || "").trim();

    const existingPdfId = String(deal?.properties?.deliverable_pdf_file_id || "").trim();
    const existingCsvId = String(deal?.properties?.deliverable_csv_file_id || "").trim();
    let existingPdfUrl = String(deal?.properties?.deliverable_pdf_url || "").trim();
    let existingCsvUrl = String(deal?.properties?.deliverable_csv_url || "").trim();

    // Recover URLs if missing
    if ((existingPdfId && !existingPdfUrl) || (existingCsvId && !existingCsvUrl)) {
      const recoveredPdfUrl = existingPdfUrl || await getFileHostingUrl(existingPdfId);
      const recoveredCsvUrl = existingCsvUrl || await getFileHostingUrl(existingCsvId);

      if (recoveredPdfUrl) existingPdfUrl = recoveredPdfUrl;
      if (recoveredCsvUrl) existingCsvUrl = recoveredCsvUrl;

      if (existingPdfUrl) {
        await patchDealWithFallback(deal_id, {
          lead_id,
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
          recovered_deal_id: recovered_deal_id || null,
          deal_lookup_attempts,
          pdf_file_id: existingPdfId,
          csv_file_id: existingCsvId,
          pdf_url: existingPdfUrl,
          csv_url: existingCsvUrl || null,
          folder_used: folderId ? { folderId } : { folderPath },
          access: ACCESS,
          portal: portalMeta ? { portalId: portalMeta.portalId } : null,
        }),
      };
    }

    if (!force && leadStatus === "Deliverables Processing") {
      return {
        statusCode: 202,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          ok: false,
          processing: true,
          deal_id,
          lead_id,
          recovered_deal_id: recovered_deal_id || null,
          deal_lookup_attempts,
          message: "Deliverables are already processing for this deal. Retry shortly.",
          pdf_url: existingPdfUrl || null,
          csv_url: existingCsvUrl || null,
          portal: portalMeta ? { portalId: portalMeta.portalId } : null,
        }),
      };
    }

    await patchDealWithFallback(deal_id, { lead_id, lead_status: "Deliverables Processing" });

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
      if (noteId) await associateDefault("note", noteId, "deal", deal_id);
    } catch (e) {
      noteWarning = String(e?.message || e);
    }

    const desc =
      `Visitor PDF URL: ${pdfUp.url}
Visitor CSV URL: ${csvUp.url}
` +
      `PDF File ID: ${pdfUp.fileId}
CSV File ID: ${csvUp.fileId}
` +
      (noteId ? `Note ID: ${noteId}
` : "") +
      (recovered_deal_id ? `Recovered Deal ID: ${recovered_deal_id}
` : "");

    const patch = await patchDealWithFallback(deal_id, {
      lead_id,
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
        deal_id: patch.deal_id || deal_id,
        lead_id,
        recovered_deal_id: recovered_deal_id || (patch.recovered ? patch.deal_id : null),
        deal_lookup_attempts: patch.deal_lookup_attempts || deal_lookup_attempts,
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
        portal: portalMeta ? { portalId: portalMeta.portalId } : null,
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
