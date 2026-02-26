// netlify/functions/upload-deliverables.js
export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "http://www.homesecurecalculator.com",
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

  const headers = corsHeaders(event.headers?.origin);

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };

  const FOLDER_ID = String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim();
  const FOLDER_PATH = String(process.env.HUBSPOT_FILES_FOLDER_PATH || "").trim();

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  const hsGet = (path) => fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: hsAuth });
  const hsPost = (path, body) => fetchJson(`https://api.hubapi.com${path}`, {
    method: "POST",
    headers: { ...hsAuth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const hsPatch = (path, body) => fetchJson(`https://api.hubapi.com${path}`, {
    method: "PATCH",
    headers: { ...hsAuth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // Cache deal prop existence
  const propExistsCache = new Map();
  async function dealPropExists(name) {
    if (!name) return false;
    if (propExistsCache.has(name)) return propExistsCache.get(name);
    const r = await hsGet(`/crm/v3/properties/deals/${encodeURIComponent(name)}`);
    propExistsCache.set(name, !!r.ok);
    return !!r.ok;
  }

  function b64ToBlob(b64, mime) {
    const buf = Buffer.from(String(b64 || ""), "base64");
    return new Blob([buf], { type: mime });
  }

  async function uploadPrivateFile({ blob, filename }) {
    // HubSpot requires folderId/folderPath as multipart fields (not inside options JSON). :contentReference[oaicite:3]{index=3}
    const form = new FormData();
    form.append("options", JSON.stringify({
      access: "PRIVATE",
      overwrite: false,
      duplicateValidationStrategy: "NONE",
    }));
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

  // Association type id for Note -> Deal is 214 (HubSpot-defined). :contentReference[oaicite:4]{index=4}
  const NOTE_TO_DEAL_TYPE_ID = 214;

  async function createNoteWithAttachment({ dealId, fileId, bodyText }) {
    const r = await hsPost("/crm/v3/objects/notes", {
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_note_body: String(bodyText || "Attached file for deal"),
        // For multiple files, HubSpot supports semicolon-separated ids; we use single per note here.
        hs_attachment_ids: String(fileId),
      },
      associations: [
        {
          to: { id: String(dealId) },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_DEAL_TYPE_ID }]
        }
      ]
    });
    if (!r.ok || !r.json?.id) {
      throw new Error("Note create failed: " + (r.text || ""));
    }
    return String(r.json.id);
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const lead_id = String(body.lead_id || "").trim();
    const deal_id = String(body.deal_id || "").trim();
    const pdf_base64 = String(body.pdf_base64 || "").trim();
    const csv_text = String(body.csv_text || "");

    if (!deal_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing deal_id" }) };
    if (!lead_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing lead_id" }) };
    if (!pdf_base64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing pdf_base64" }) };
    if (!csv_text) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing csv_text" }) };

    // Ensure deal exists
    const dealCheck = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(deal_id)}?properties=dealname,lead_id`);
    if (!dealCheck.ok) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Deal not found", deal_id, detail: dealCheck.text }) };
    }

    // Optional: mark "processing"
    const statusProps = {};
    if (await dealPropExists("lead_status")) statusProps.lead_status = "Deliverables Processing";
    if (await dealPropExists("listing_status")) statusProps.listing_status = "Deliverables Processing";
    if (Object.keys(statusProps).length) {
      await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(deal_id)}`, { properties: statusProps });
    }

    const pdfFilename = `home-secure-report-${deal_id}.pdf`;
    const csvFilename = `home-secure-lead-${deal_id}.csv`;

    const pdfBlob = b64ToBlob(pdf_base64, "application/pdf");
    const csvBlob = new Blob([Buffer.from(csv_text, "utf8")], { type: "text/csv" });

    const pdfUp = await uploadPrivateFile({ blob: pdfBlob, filename: pdfFilename });
    if (!pdfUp.ok || !pdfUp.json?.id) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "PDF upload failed", detail: pdfUp.text, folderId: FOLDER_ID, folderPath: FOLDER_PATH }) };
    }

    const csvUp = await uploadPrivateFile({ blob: csvBlob, filename: csvFilename });
    if (!csvUp.ok || !csvUp.json?.id) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "CSV upload failed", detail: csvUp.text, folderId: FOLDER_ID, folderPath: FOLDER_PATH }) };
    }

    const pdfFileId = String(pdfUp.json.id);
    const csvFileId = String(csvUp.json.id);

    // Create notes (attachments) on the deal timeline
    const notePdfId = await createNoteWithAttachment({
      dealId: deal_id,
      fileId: pdfFileId,
      bodyText: `Deliverable: Security Report PDF (lead_id=${lead_id})`
    });

    const noteCsvId = await createNoteWithAttachment({
      dealId: deal_id,
      fileId: csvFileId,
      bodyText: `Deliverable: Lead CSV (lead_id=${lead_id})`
    });

    // Store ids on the deal if these props exist (optional but strongly recommended)
    const patch = {};
    if (await dealPropExists("deliverable_pdf_file_id")) patch.deliverable_pdf_file_id = pdfFileId;
    if (await dealPropExists("deliverable_csv_file_id")) patch.deliverable_csv_file_id = csvFileId;
    if (await dealPropExists("deliverable_pdf_note_id")) patch.deliverable_pdf_note_id = notePdfId;
    if (await dealPropExists("deliverable_csv_note_id")) patch.deliverable_csv_note_id = noteCsvId;

    // Ready but unpaid (you can rename statuses however you like)
    if (await dealPropExists("lead_status")) patch.lead_status = "Deliverables Ready (Unpaid)";
    if (await dealPropExists("listing_status")) patch.listing_status = "Unpaid";

    if (Object.keys(patch).length) {
      const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(deal_id)}`, { properties: patch });
      if (!patched.ok) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Deal update failed (deliverable ids)", detail: patched.text }) };
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        lead_id,
        deal_id,
        pdf_file_id: pdfFileId,
        csv_file_id: csvFileId,
        pdf_note_id: notePdfId,
        csv_note_id: noteCsvId,
        folderId: FOLDER_ID || null,
        folderPath: FOLDER_PATH || null,
      })
    };
  } catch (err) {
    console.error("upload-deliverables error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
