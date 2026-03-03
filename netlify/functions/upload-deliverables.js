// netlify/functions/upload-deliverables.js
// CLEAN + RELIABLE VERSION
// ✅ Upload visitor PDF + PII CSV to HubSpot Files
// ✅ Patch Deal with deliverable_* URLs + file IDs
// ✅ If deal_id is missing: server resolves it using lead_id (and dealname fallback)
// ✅ No notes / no associations / no lead_status / no description updates
//
// ENV:
//   HUBSPOT_PRIVATE_APP_TOKEN (required)
//   HUBSPOT_FILES_FOLDER_PATH (recommended) e.g. "/HomeSecureCalculator/Deliverables"
//   HUBSPOT_FILES_FOLDER_ID   (optional fallback)
//   HUBSPOT_FILES_ACCESS      (optional) "PUBLIC_NOT_INDEXABLE" | "PRIVATE" (default PUBLIC_NOT_INDEXABLE)
//
// POST body JSON:
// {
//   lead_id: "uuid" (required),
//   deal_id: "123"  (optional; resolved if missing),
//   email: "a@b.com" (optional but recommended),
//   pdf_base64: "..." (required; base64 or dataURL),
//   csv_text: "..." (optional; if missing, generated from payload),
//   payload: {...} (recommended; used for CSV + deal resolution fallback)
// }

export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "http://www.homesecurecalculator.com",
    "http://homesecurecalculator.com",
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

  // Prefer folderPath for reliability (folderId caused 404s in prior runs)
  const rawFolderPath = String(process.env.HUBSPOT_FILES_FOLDER_PATH || "").trim();
  const rawFolderId = String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim();
  const folderPath = rawFolderPath || "/";
  const folderId = rawFolderId || "";

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

  function buildCsvFromPayload(payloadObj) {
    // Flatten to key/value CSV (PII is included if present in payload)
    const out = [];
    out.push(["key", "value"]);
    const seen = new Set();

    function add(k, v) {
      const kk = String(k || "");
      if (!kk || seen.has(kk)) return;
      seen.add(kk);
      out.push([kk, String(v ?? "")]);
    }

    function walk(obj, prefix) {
      if (!obj || typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? (prefix + "." + k) : k;
        if (v && typeof v === "object" && !Array.isArray(v)) walk(v, key);
        else add(key, Array.isArray(v) ? JSON.stringify(v) : v);
      }
    }

    walk(payloadObj, "");
    return out
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
  }

  async function patchDealWithFallback(dealId, properties) {
    const attempt = async (props) =>
      fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
        method: "PATCH",
        headers: { ...hsAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: props }),
      });

    let r = await attempt(properties);
    if (r.ok) return { ...r, dropped: [] };

    const badProps = new Set(
      (r.json?.errors || [])
        .filter((e) => e.code === "PROPERTY_DOESNT_EXIST")
        .flatMap((e) => e.context?.propertyName || [])
    );

    if (badProps.size) {
      const filtered = Object.fromEntries(Object.entries(properties).filter(([k]) => !badProps.has(k)));
      if (Object.keys(filtered).length) {
        const r2 = await attempt(filtered);
        return { ...r2, dropped: Array.from(badProps) };
      }
      return { ...r, dropped: Array.from(badProps) };
    }

    return { ...r, dropped: [] };
  }

  async function readDealDeliverableProps(dealId) {
    const r = await fetchJson(
      `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}` +
      `?properties=deliverable_pdf_file_id,deliverable_csv_file_id,deliverable_pdf_url,deliverable_csv_url`,
      { method: "GET", headers: { ...hsAuth } }
    );
    if (!r.ok) return null;
    return r.json;
  }

  async function searchDealByLeadIdProp(leadId) {
    const body = {
      filterGroups: [{
        filters: [{ propertyName: "lead_id", operator: "EQ", value: String(leadId) }]
      }],
      properties: ["dealname"],
      limit: 3
    };

    return fetchJson("https://api.hubapi.com/crm/v3/objects/deals/search", {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function searchDealByNameContainsLeadId(leadId) {
    const body = {
      filterGroups: [{
        filters: [{ propertyName: "dealname", operator: "CONTAINS_TOKEN", value: String(leadId) }]
      }],
      properties: ["dealname"],
      limit: 3
    };

    return fetchJson("https://api.hubapi.com/crm/v3/objects/deals/search", {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function resolveDealId({ deal_id, lead_id, payload }) {
    const direct =
      String(deal_id || "").trim() ||
      String(payload?.deal_id || payload?.dealId || "").trim();

    if (direct) return direct;

    // 1) Try lead_id property search (if your portal has deal property "lead_id")
    let r1 = await searchDealByLeadIdProp(lead_id);
    if (r1.ok) {
      const id = String(r1.json?.results?.[0]?.id || "").trim();
      if (id) return id;
    } else {
      // If property doesn't exist, HubSpot returns 400; we just fall back.
    }

    // 2) Fallback: dealname contains the lead_id (works with your typical naming pattern)
    const r2 = await searchDealByNameContainsLeadId(lead_id);
    if (r2.ok) {
      const id = String(r2.json?.results?.[0]?.id || "").trim();
      if (id) return id;
    }

    return "";
  }

  async function uploadFileToHubSpot({ bytes, filename, mimeType }) {
    const options = {
      access: ACCESS,
      overwrite: false,
      duplicateValidationStrategy: "NONE",
    };

    // Prefer folderPath when provided
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    form.append("fileName", filename);
    form.append("options", JSON.stringify(options));

    if (rawFolderPath) form.append("folderPath", String(folderPath));
    else if (folderId) form.append("folderId", String(folderId));
    else form.append("folderPath", "/");

    let res = await fetchJson("https://api.hubapi.com/files/v3/files", {
      method: "POST",
      headers: { ...hsAuth }, // do not set Content-Type (boundary)
      body: form,
    });

    // Folder fallback to root if folder configuration is wrong
    if (!res.ok) {
      const msg = (res.text || JSON.stringify(res.json || {})).toLowerCase();
      const looksFolderRelated =
        res.status === 404 ||
        msg.includes("no folder exists") ||
        msg.includes("folder") ||
        msg.includes("folderid") ||
        msg.includes("folderpath");

      if (looksFolderRelated) {
        const form2 = new FormData();
        form2.append("file", new Blob([bytes], { type: mimeType }), filename);
        form2.append("fileName", filename);
        form2.append("options", JSON.stringify(options));
        form2.append("folderPath", "/");

        res = await fetchJson("https://api.hubapi.com/files/v3/files", {
          method: "POST",
          headers: { ...hsAuth },
          body: form2,
        });
      }
    }

    if (!res.ok) {
      throw new Error(`HubSpot file upload failed (${res.status}): ${res.text || JSON.stringify(res.json)}`);
    }

    const fileId = String(res.json?.id || "").trim();
    if (!fileId) throw new Error(`HubSpot upload missing file id: ${res.text || JSON.stringify(res.json)}`);

    const url = String(res.json?.defaultHostingUrl || res.json?.url || "").trim();
    return { fileId, url, raw: res.json };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const lead_id = String(body.lead_id || "").trim();
    const payload = body.payload && typeof body.payload === "object" ? body.payload : null;

    let deal_id = String(body.deal_id || "").trim();
    const email =
      String(body.email || "").trim() ||
      String(payload?.email || payload?.Email || payload?.user_email || "").trim() ||
      "";

    const pdf_base64 = stripDataUrl(body.pdf_base64);

    // csv_text optional; if missing generate from payload
    const csv_text =
      String(body.csv_text || "").trim() ||
      (payload ? buildCsvFromPayload(payload) : "");

    if (!lead_id) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing lead_id" }) };
    }
    if (!pdf_base64) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing pdf_base64" }) };
    }
    if (!csv_text) {
      return {
        statusCode: 400,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Missing csv_text (or payload to generate CSV)" }),
      };
    }

    // ✅ Resolve deal_id if missing
    deal_id = await resolveDealId({ deal_id, lead_id, payload });
    if (!deal_id) {
      return {
        statusCode: 404,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "Deal not found for lead_id",
          detail:
            "No deal_id was provided and server could not resolve a matching deal. " +
            "Fix by passing deal_id from calculator to results URL OR ensure deal name includes lead_id.",
          lead_id,
        }),
      };
    }

    // Idempotency: reuse if already present
    const deal = await readDealDeliverableProps(deal_id);
    const existingPdfUrl = String(deal?.properties?.deliverable_pdf_url || "").trim();
    const existingCsvUrl = String(deal?.properties?.deliverable_csv_url || "").trim();
    const existingPdfId  = String(deal?.properties?.deliverable_pdf_file_id || "").trim();
    const existingCsvId  = String(deal?.properties?.deliverable_csv_file_id || "").trim();

    if (existingPdfUrl && existingCsvUrl) {
      return {
        statusCode: 200,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          ok: true,
          reused: true,
          lead_id,
          deal_id,
          email: email || null,
          pdf_url: existingPdfUrl,
          csv_url: existingCsvUrl,
          pdf_file_id: existingPdfId || null,
          csv_file_id: existingCsvId || null,
          folder_used: rawFolderPath ? { folderPath } : (folderId ? { folderId } : { folderPath: "/" }),
          access: ACCESS,
        }),
      };
    }

    const pdfBytes = Buffer.from(pdf_base64, "base64");
    const csvBytes = Buffer.from(csv_text, "utf8");

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const pdfName = safeFileName(`HomeSecure_Report_${lead_id}_${deal_id}_${ts}.pdf`);
    const csvName = safeFileName(`HomeSecure_PII_${lead_id}_${deal_id}_${ts}.csv`);

    const pdfUp = await uploadFileToHubSpot({ bytes: pdfBytes, filename: pdfName, mimeType: "application/pdf" });
    const csvUp = await uploadFileToHubSpot({ bytes: csvBytes, filename: csvName, mimeType: "text/csv" });

    const propsToWrite = {
      deliverable_pdf_file_id: pdfUp.fileId,
      deliverable_csv_file_id: csvUp.fileId,
      deliverable_pdf_url: pdfUp.url,
      deliverable_csv_url: csvUp.url,
    };

    const patch = await patchDealWithFallback(deal_id, propsToWrite);

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        reused: false,
        lead_id,
        deal_id,
        email: email || null,
        pdf_file_id: pdfUp.fileId,
        csv_file_id: csvUp.fileId,
        pdf_url: pdfUp.url,
        csv_url: csvUp.url,
        deal_patch_ok: patch.ok,
        deal_patch_status: patch.status,
        deal_patch_dropped_props: patch.dropped || [],
        folder_used: rawFolderPath ? { folderPath } : (folderId ? { folderId } : { folderPath: "/" }),
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
          HUBSPOT_FILES_FOLDER_PATH: String(process.env.HUBSPOT_FILES_FOLDER_PATH || "").trim() || null,
          HUBSPOT_FILES_FOLDER_ID: String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim() || null,
          HUBSPOT_FILES_ACCESS: String(process.env.HUBSPOT_FILES_ACCESS || "PUBLIC_NOT_INDEXABLE").trim(),
        },
      }),
    };
  }
}
