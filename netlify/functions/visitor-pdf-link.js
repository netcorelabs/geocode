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
    return fetchJson(`https://api.hubapi.com${path}`, { method: "POST", headers: { ...hsAuth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  async function hsPatch(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "PATCH", headers: { ...hsAuth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  async function dealPropertyExists(name){
    const r = await hsGet(`/crm/v3/properties/deals/${encodeURIComponent(name)}`);
    return r.ok;
  }

  async function findDealByLeadId(leadId){
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id", "deliverable_pdf_file_id", "deliverable_csv_file_id"],
      limit: 1,
    });
    return r.ok && r.json?.results?.[0] ? r.json.results[0] : null;
  }

  function b64ToBlob(b64, mime){
    const buf = Buffer.from(String(b64 || ""), "base64");
    return new Blob([buf], { type: mime });
  }

  async function uploadFileToHubSpot({ blob, filename, mimeType }) {
    // HubSpot Files v3 upload (multipart)
    const form = new FormData();

    // options: PRIVATE file
    form.append("options", JSON.stringify({
      access: "PRIVATE",
      overwrite: false,
      duplicateValidationStrategy: "NONE",
    }));

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

  try {
    const body = JSON.parse(event.body || "{}");
    const lead_id = String(body.lead_id || "").trim();
    const pdf_base64 = String(body.pdf_base64 || "").trim();
    const csv_text = String(body.csv_text || "");
    const csv_base64 = String(body.csv_base64 || "").trim();

    if (!lead_id) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing lead_id" }) };
    if (!pdf_base64) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing pdf_base64" }) };
    if (!csv_text && !csv_base64) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing csv_text or csv_base64" }) };

    // Ensure required deal properties exist
    const okLead = await dealPropertyExists("lead_id");
    if(!okLead){
      return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing Deal property: lead_id" }) };
    }
    const okPdf = await dealPropertyExists("deliverable_pdf_file_id");
    const okCsv = await dealPropertyExists("deliverable_csv_file_id");
    if(!okPdf || !okCsv){
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "Missing Deal properties for deliverables",
          required: ["deliverable_pdf_file_id", "deliverable_csv_file_id"],
          fix: "Create these as custom Deal properties (single-line text) in the portal tied to HUBSPOT_PRIVATE_APP_TOKEN."
        })
      };
    }

    const deal = await findDealByLeadId(lead_id);
    if(!deal?.id){
      return { statusCode: 404, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal not found for lead_id", lead_id }) };
    }

    const dealId = deal.id;

    const pdfFilename = `home-secure-report-${dealId}.pdf`;
    const csvFilename = `home-secure-lead-${dealId}.csv`;

    const pdfBlob = b64ToBlob(pdf_base64, "application/pdf");

    let csvBlob;
    if (csv_base64) {
      csvBlob = b64ToBlob(csv_base64, "text/csv");
    } else {
      csvBlob = new Blob([csv_text], { type: "text/csv" });
    }

    const pdfUp = await uploadFileToHubSpot({ blob: pdfBlob, filename: pdfFilename, mimeType: "application/pdf" });
    if(!pdfUp.ok || !pdfUp.json?.id){
      return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "PDF upload failed", detail: pdfUp.text }) };
    }

    const csvUp = await uploadFileToHubSpot({ blob: csvBlob, filename: csvFilename, mimeType: "text/csv" });
    if(!csvUp.ok || !csvUp.json?.id){
      return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "CSV upload failed", detail: csvUp.text }) };
    }

    const pdfFileId = String(pdfUp.json.id);
    const csvFileId = String(csvUp.json.id);

    const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      properties: {
        deliverable_pdf_file_id: pdfFileId,
        deliverable_csv_file_id: csvFileId,
      }
    });

    if(!patched.ok){
      return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal update failed (file ids)", detail: patched.text }) };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ ok: true, lead_id, deal_id: dealId, pdf_file_id: pdfFileId, csv_file_id: csvFileId })
    };
  } catch (err) {
    console.error("upload-deliverables error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
