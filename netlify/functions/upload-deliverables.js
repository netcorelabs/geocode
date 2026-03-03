// netlify/functions/upload-deliverables.js
export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "https://www.netcoreleads.com",
    "https://netcoreleads.com",
    "https://api.netcoreleads.com",
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

  const folderId = String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim();
  const folderPath = String(process.env.HUBSPOT_FILES_FOLDER_PATH || "").trim() || "/Home Secure Calculator";

  const hsAuthOnly = { Authorization: `Bearer ${HS_TOKEN}` };
  const hsJsonHeaders = { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" };

  async function readText(r){ try{ return await r.text(); } catch { return ""; } }
  async function fetchJson(url, options){
    const r = await fetch(url, options);
    const t = await readText(r);
    let j=null; try{ j = t ? JSON.parse(t) : null; } catch { j=null; }
    return { ok:r.ok, status:r.status, json:j, text:t };
  }

  function stripBase64(x){
    const s = String(x || "");
    const i = s.indexOf("base64,");
    return i >= 0 ? s.slice(i + 7).trim() : s.trim();
  }

  function safeFileName(name) {
    return String(name || "file").replace(/[^\w\-(). ]+/g, "_").replace(/\s+/g, "_").slice(0, 160);
  }

  async function hsPost(path, body){
    return fetchJson(`https://api.hubapi.com${path}`, { method:"POST", headers: hsJsonHeaders, body: JSON.stringify(body) });
  }
  async function hsPatch(path, body){
    return fetchJson(`https://api.hubapi.com${path}`, { method:"PATCH", headers: hsJsonHeaders, body: JSON.stringify(body) });
  }
  async function hsGet(path){
    return fetchJson(`https://api.hubapi.com${path}`, { method:"GET", headers: hsAuthOnly });
  }

  async function patchDealWithFallback(dealId, properties){
    const attempt = async (props)=>hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: props });

    let r = await attempt(properties);
    if (r.ok) return r;

    const badProps = new Set(
      (r.json?.errors || [])
        .filter(e => e.code === "PROPERTY_DOESNT_EXIST")
        .flatMap(e => e.context?.propertyName || [])
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

  async function uploadFilePublic({ bytes, filename, mimeType }) {
    // PUBLIC_NOT_INDEXABLE = public URL accessible; not indexed :contentReference[oaicite:1]{index=1}
    const options = { access: "PUBLIC_NOT_INDEXABLE", overwrite: false, duplicateValidationStrategy: "NONE" };

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    form.append("options", JSON.stringify(options));
    if (folderId) form.append("folderId", folderId);
    else form.append("folderPath", folderPath);

    const res = await fetchJson("https://api.hubapi.com/files/v3/files", {
      method: "POST",
      headers: { ...hsAuthOnly }, // let fetch set boundary
      body: form,
    });

    if (!res.ok) throw new Error(`File upload failed (${res.status}): ${res.text}`);

    const fileId = String(res.json?.id || "").trim();
    // To reliably get URL, fetch the file record (HubSpot docs say it returns URL) :contentReference[oaicite:2]{index=2}
    const fileMeta = fileId ? await hsGet(`/files/v3/files/${encodeURIComponent(fileId)}`) : null;

    const url =
      String(fileMeta?.json?.url || res.json?.url || res.json?.path || "").trim() ||
      "";

    return { fileId, url, raw: res.json, meta: fileMeta?.json || null };
  }

  try{
    const body = JSON.parse(event.body || "{}");

    const lead_id = String(body.lead_id || "").trim();
    const deal_id = String(body.deal_id || "").trim();
    const email = String(body.email || "").trim(); // optional, stored in description
    const pdf_base64 = stripBase64(body.pdf_base64);
    const csv_text = String(body.csv_text || "");
    const payload = (body.payload && typeof body.payload === "object") ? body.payload : null;

    if (!lead_id) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing lead_id" }) };
    if (!deal_id) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id" }) };
    if (!pdf_base64) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing pdf_base64" }) };
    if (!csv_text) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing csv_text" }) };

    // Idempotency: if deal already has URLs/IDs, reuse
    const existing = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(deal_id)}?properties=deliverable_pdf_file_id,deliverable_csv_file_id,deliverable_pdf_url,deliverable_csv_url,description`);
    if (existing.ok) {
      const p = existing.json?.properties || {};
      const hasPdf = String(p.deliverable_pdf_file_id || "").trim() && String(p.deliverable_pdf_url || "").trim();
      const hasCsv = String(p.deliverable_csv_file_id || "").trim() && String(p.deliverable_csv_url || "").trim();
      if (hasPdf && hasCsv) {
        return {
          statusCode: 200,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({
            ok: true,
            reused: true,
            lead_id,
            deal_id,
            pdf_file_id: p.deliverable_pdf_file_id,
            pdf_url: p.deliverable_pdf_url,
            csv_file_id: p.deliverable_csv_file_id,
            csv_url: p.deliverable_csv_url
          })
        };
      }
    }

    // upload
    const pdfBytes = Buffer.from(pdf_base64, "base64");
    const csvBytes = Buffer.from(csv_text, "utf8");

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const pdfName = safeFileName(`Exclusive_Lead_${lead_id}_${ts}.pdf`);
    const csvName = safeFileName(`Exclusive_Lead_${lead_id}_${ts}.csv`);

    await patchDealWithFallback(deal_id, { lead_status: "Deliverables Processing" });

    const pdfUp = await uploadFilePublic({ bytes: pdfBytes, filename: pdfName, mimeType: "application/pdf" });
    const csvUp = await uploadFilePublic({ bytes: csvBytes, filename: csvName, mimeType: "text/csv" });

    const desc =
      `Exclusive Lead Deliverables\n` +
      `lead_id=${lead_id}\n` +
      `deal_id=${deal_id}\n` +
      (email ? `email=${email}\n` : "") +
      `pdf_file_id=${pdfUp.fileId}\n` +
      `pdf_url=${pdfUp.url}\n` +
      `csv_file_id=${csvUp.fileId}\n` +
      `csv_url=${csvUp.url}\n` +
      `folder=${folderId ? `folderId=${folderId}` : `folderPath=${folderPath}`}\n` +
      (payload ? `\n--- payload snapshot (json) ---\n${JSON.stringify(payload).slice(0, 6000)}\n` : "");

    // Store on Deal (best effort; if these properties don't exist, it will still store in description)
    await patchDealWithFallback(deal_id, {
      deliverable_pdf_file_id: pdfUp.fileId,
      deliverable_csv_file_id: csvUp.fileId,
      deliverable_pdf_url: pdfUp.url,
      deliverable_csv_url: csvUp.url,
      lead_status: "Deliverables Ready",
      description: desc
    });

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        lead_id,
        deal_id,
        pdf_file_id: pdfUp.fileId,
        pdf_url: pdfUp.url,
        csv_file_id: csvUp.fileId,
        csv_url: csvUp.url,
        folder_used: folderId ? { folderId } : { folderPath }
      })
    };

  } catch(err){
    console.error("upload-deliverables error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "upload-deliverables failed", detail: String(err?.message || err) })
    };
  }
}
