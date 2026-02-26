// netlify/functions/vendor-deliverables-link.js
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
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Vary": "Origin",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    };
  }

  const headers = corsHeaders(event.headers?.origin);

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };

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
  const hsPatch = (path, body) => fetchJson(`https://api.hubapi.com${path}`, {
    method: "PATCH",
    headers: { ...hsAuth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  async function createSignedUrl(fileId) {
    const r = await fetchJson(`https://api.hubapi.com/files/v3/files/${encodeURIComponent(fileId)}/signed-url`, {
      method: "GET",
      headers: hsAuth,
    });
    const url = String(r.json?.url || "").trim();
    if (!r.ok || !url) return { ok: false, status: r.status, text: r.text || "Failed to create signed URL" };
    return { ok: true, url };
  }

  function readInputs() {
    if (event.httpMethod === "GET") {
      const qs = event.queryStringParameters || {};
      return {
        deal_id: String(qs.deal_id || "").trim(),
      };
    }
    try {
      const b = JSON.parse(event.body || "{}");
      return { deal_id: String(b.deal_id || "").trim() };
    } catch {
      return { deal_id: "" };
    }
  }

  try {
    const { deal_id } = readInputs();
    if (!deal_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing deal_id" }) };

    const deal = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(deal_id)}?properties=listing_status,lead_status,deliverable_pdf_file_id,deliverable_csv_file_id`);
    if (!deal.ok) return { statusCode: 404, headers, body: JSON.stringify({ error: "Deal not found", detail: deal.text }) };

    const props = deal.json?.properties || {};
    const listing = String(props.listing_status || "").trim().toLowerCase();
    const leadStatus = String(props.lead_status || "").trim().toLowerCase();

    const isPaid = (listing === "paid") || leadStatus.includes("paid");
    if (!isPaid) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Not paid", listing_status: props.listing_status || null, lead_status: props.lead_status || null }) };
    }

    const pdfFileId = String(props.deliverable_pdf_file_id || "").trim();
    const csvFileId = String(props.deliverable_csv_file_id || "").trim();

    if (!pdfFileId || !csvFileId) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: "Deliverables not ready", pdf_file_id: pdfFileId || null, csv_file_id: csvFileId || null }) };
    }

    const pdf = await createSignedUrl(pdfFileId);
    if (!pdf.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: "Signed URL failed (pdf)", detail: pdf.text }) };

    const csv = await createSignedUrl(csvFileId);
    if (!csv.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: "Signed URL failed (csv)", detail: csv.text }) };

    // Optional: store temporarily (signed urls expire — consider storing only for short periods)
    // Create these deal props if you want: deliverable_pdf_signed_url, deliverable_csv_signed_url, deliverables_last_signed_at
    await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(deal_id)}`, {
      properties: {
        deliverable_pdf_signed_url: pdf.url,
        deliverable_csv_signed_url: csv.url,
        deliverables_last_signed_at: new Date().toISOString(),
      }
    }).catch(() => null);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        deal_id,
        pdf_url: pdf.url,
        csv_url: csv.url,
      })
    };
  } catch (err) {
    console.error("vendor-deliverables-link error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
