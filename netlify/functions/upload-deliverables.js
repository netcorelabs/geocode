// netlify/functions/upload-deliverables.js
export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
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

  const rawFolderPath = String(process.env.HUBSPOT_FILES_FOLDER_PATH || "").trim();
  const rawFolderId = String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim();
  const folderPath = rawFolderPath || "/";
  const folderId = rawFolderId || "";

  const ACCESS = String(process.env.HUBSPOT_FILES_ACCESS || "PUBLIC_NOT_INDEXABLE").trim() || "PUBLIC_NOT_INDEXABLE";
  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  // ✅ If your existing deliverable_*_url properties are NUMBER fields, change these to your new URL/text props:
  const DEAL_PROP_PDF_URL  = "deliverable_pdf_url"; // or "deliverable_pdf_link"
  const DEAL_PROP_CSV_URL  = "deliverable_csv_url"; // or "deliverable_csv_link"
  const DEAL_PROP_PDF_ID   = "deliverable_pdf_file_id";
  const DEAL_PROP_CSV_ID   = "deliverable_csv_file_id";

  async function readText(res){ try{ return await res.text(); }catch{ return ""; } }
  async function fetchJson(url, options = {}){
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try{ json = text ? JSON.parse(text) : null; }catch{ json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  function stripDataUrl(s){
    const str = String(s || "");
    const idx = str.indexOf("base64,");
    return idx >= 0 ? str.slice(idx + 7).trim() : str.trim();
  }

  function safeFileName(name){
    return String(name || "file")
      .replace(/[^\w.\-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 180);
  }

  function buildCsvFromPayload(payloadObj){
    const out = [["key","value"]];
    const seen = new Set();

    function add(k, v){
      const kk = String(k || "");
      if(!kk || seen.has(kk)) return;
      seen.add(kk);
      out.push([kk, String(v ?? "")]);
    }
    function walk(obj, prefix){
      if(!obj || typeof obj !== "object") return;
      for(const [k,v] of Object.entries(obj)){
        const key = prefix ? (prefix + "." + k) : k;
        if(v && typeof v === "object" && !Array.isArray(v)) walk(v, key);
        else add(key, Array.isArray(v) ? JSON.stringify(v) : v);
      }
    }
    walk(payloadObj, "");
    return out.map(row => row.map(cell => `"${String(cell).replace(/"/g,'""')}"`).join(",")).join("\n");
  }

  async function patchDealResilient(dealId, properties){
    // Patch; if HubSpot rejects any property (wrong type, missing, etc), drop it and retry.
    const attempt = async (props) => fetchJson(
      `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}`,
      {
        method: "PATCH",
        headers: { ...hsAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: props }),
      }
    );

    let r = await attempt(properties);
    if (r.ok) return { ...r, dropped: [] };

    const bad = new Set(
      (r.json?.errors || [])
        .flatMap(e => e.context?.propertyName || [])
    );

    // Also catch some cases where context isn't set; try parsing message
    if (!bad.size && typeof r.text === "string") {
      const m = r.text.match(/propertyName["']?\s*:\s*["']([^"']+)["']/i);
      if (m && m[1]) bad.add(m[1]);
    }

    if (bad.size) {
      const filtered = Object.fromEntries(Object.entries(properties).filter(([k]) => !bad.has(k)));
      if (Object.keys(filtered).length) {
        const r2 = await attempt(filtered);
        return { ...r2, dropped: Array.from(bad) };
      }
      return { ...r, dropped: Array.from(bad) };
    }

    return { ...r, dropped: [] };
  }

  async function uploadFileToHubSpot({ bytes, filename, mimeType }){
    const options = { access: ACCESS, overwrite: false, duplicateValidationStrategy: "NONE" };

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    form.append("fileName", filename);
    form.append("options", JSON.stringify(options));

    if (rawFolderPath) form.append("folderPath", String(folderPath));
    else if (folderId) form.append("folderId", String(folderId));
    else form.append("folderPath", "/");

    const res = await fetchJson("https://api.hubapi.com/files/v3/files", {
      method: "POST",
      headers: { ...hsAuth }, // do not set Content-Type boundary
      body: form,
    });

    if (!res.ok) throw new Error(`HubSpot file upload failed (${res.status}): ${res.text || JSON.stringify(res.json)}`);

    const fileId = String(res.json?.id || "").trim();
    if (!fileId) throw new Error(`HubSpot upload missing file id: ${res.text || JSON.stringify(res.json)}`);

    // May or may not be present in create response; we’ll verify.
    let url = String(res.json?.defaultHostingUrl || res.json?.url || "").trim();

    // If missing/invalid URL, fetch file record to get hosting URL.
    if (!/^https?:\/\//i.test(url)) {
      const r2 = await fetchJson(`https://api.hubapi.com/files/v3/files/${encodeURIComponent(fileId)}`, {
        method: "GET",
        headers: { ...hsAuth },
      });
      const u2 = String(r2.json?.defaultHostingUrl || r2.json?.url || "").trim();
      if (/^https?:\/\//i.test(u2)) url = u2;
    }

    return { fileId, url };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const lead_id = String(body.lead_id || "").trim();
    const deal_id = String(body.deal_id || "").trim(); // still required in this deployed version
    const payload = body.payload && typeof body.payload === "object" ? body.payload : null;

    const email =
      String(body.email || "").trim() ||
      String(payload?.email || payload?.Email || payload?.user_email || "").trim() ||
      "";

    const pdf_base64 = stripDataUrl(body.pdf_base64);
    const csv_text =
      String(body.csv_text || "").trim() ||
      (payload ? buildCsvFromPayload(payload) : "");

    if (!lead_id || !deal_id) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing lead_id or deal_id" }) };
    if (!pdf_base64) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing pdf_base64" }) };
    if (!csv_text) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing csv_text (or payload)" }) };

    const pdfBytes = Buffer.from(pdf_base64, "base64");
    const csvBytes = Buffer.from(csv_text, "utf8");

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const pdfName = safeFileName(`HomeSecure_Report_${lead_id}_${deal_id}_${ts}.pdf`);
    const csvName = safeFileName(`HomeSecure_PII_${lead_id}_${deal_id}_${ts}.csv`);

    const pdfUp = await uploadFileToHubSpot({ bytes: pdfBytes, filename: pdfName, mimeType: "application/pdf" });
    const csvUp = await uploadFileToHubSpot({ bytes: csvBytes, filename: csvName, mimeType: "text/csv" });

    const desc =
      `Visitor PDF URL: ${pdfUp.url || "(missing)"}\nVisitor CSV URL: ${csvUp.url || "(missing)"}\n` +
      `PDF File ID: ${pdfUp.fileId}\nCSV File ID: ${csvUp.fileId}\n`;

    const patch = await patchDealResilient(deal_id, {
      [DEAL_PROP_PDF_ID]: pdfUp.fileId,
      [DEAL_PROP_CSV_ID]: csvUp.fileId,
      [DEAL_PROP_PDF_URL]: pdfUp.url || "",
      [DEAL_PROP_CSV_URL]: csvUp.url || "",
      description: desc,
    });

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        lead_id,
        deal_id,
        pdf_file_id: pdfUp.fileId,
        csv_file_id: csvUp.fileId,
        pdf_url: pdfUp.url || null,
        csv_url: csvUp.url || null,
        deal_patch_ok: patch.ok,
        deal_patch_status: patch.status,
        deal_patch_dropped_props: patch.dropped || [],
        folder_used: rawFolderPath ? { folderPath } : (folderId ? { folderId } : { folderPath: "/" }),
        access: ACCESS,
        email: email || null,
      }),
    };

  } catch (err) {
    console.error("upload-deliverables error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "upload-deliverables failed", detail: String(err?.message || err) }),
    };
  }
}
