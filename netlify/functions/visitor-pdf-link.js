// netlify/functions/visitor-pdf-link.js
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
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Vary": "Origin",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    };
  }

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  }

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) {
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }),
    };
  }

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

  async function findDealByLeadId(leadId) {
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id", "deliverable_pdf_file_id", "deliverable_csv_file_id"],
      limit: 1,
    });
    return r.ok && r.json?.results?.[0] ? r.json.results[0] : null;
  }

  async function readDealById(dealId) {
    const props = "lead_id,deliverable_pdf_file_id,deliverable_csv_file_id";
    const r = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${encodeURIComponent(props)}`);
    if (!r.ok || !r.json?.id) return null;
    return r.json;
  }

  async function createSignedUrl(fileId) {
    const r = await fetchJson(
      `https://api.hubapi.com/files/v3/files/${encodeURIComponent(fileId)}/signed-url`,
      { method: "GET", headers: hsAuth }
    );
    const url = String(r.json?.url || "").trim();
    if (!r.ok || !url) return { ok: false, status: r.status, text: r.text || "Failed to create signed URL" };
    return { ok: true, url };
  }

  function readInputs() {
    let lead_id = "";
    let deal_id = "";

    if (event.httpMethod === "GET") {
      const qs = event.queryStringParameters || {};
      lead_id = String(qs.lead_id || "").trim();
      deal_id = String(qs.deal_id || "").trim();
      return { lead_id, deal_id };
    }

    try {
      const body = JSON.parse(event.body || "{}");
      lead_id = String(body.lead_id || "").trim();
      deal_id = String(body.deal_id || "").trim();
    } catch {}
    return { lead_id, deal_id };
  }

  try {
    if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
      return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Method Not Allowed" }) };
    }

    const { lead_id, deal_id } = readInputs();

    if (!deal_id && !lead_id) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id or lead_id" }) };
    }

    // Prefer deal_id (no indexing delay)
    let deal = null;
    if (deal_id) {
      deal = await readDealById(deal_id);
      if (!deal) {
        return { statusCode: 404, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal not found for deal_id", deal_id }) };
      }
    } else {
      deal = await findDealByLeadId(lead_id);
      if (!deal?.id) {
        return { statusCode: 404, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal not found for lead_id", lead_id }) };
      }
    }

    const resolvedDealId = String(deal.id || deal_id || "").trim();
    const pdfFileId = String(deal.properties?.deliverable_pdf_file_id || "").trim();
    const csvFileId = String(deal.properties?.deliverable_csv_file_id || "").trim();

    if (!pdfFileId) {
      return {
        statusCode: 409,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "PDF not ready yet",
          deal_id: resolvedDealId,
          hint: "Run upload-deliverables first so deliverable_pdf_file_id is set on the deal.",
        }),
      };
    }

    const pdfSigned = await createSignedUrl(pdfFileId);
    if (!pdfSigned.ok) {
      return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: pdfSigned.text || "Failed to create PDF signed URL", deal_id: resolvedDealId }) };
    }

    let csv_url = null;
    if (csvFileId) {
      const csvSigned = await createSignedUrl(csvFileId);
      if (csvSigned.ok) csv_url = csvSigned.url;
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        deal_id: resolvedDealId,
        lead_id: String(deal.properties?.lead_id || lead_id || "").trim(),
        pdf_file_id: pdfFileId,
        pdf_url: pdfSigned.url,
        csv_file_id: csvFileId || null,
        csv_url,
      }),
    };
  } catch (err) {
    console.error("visitor-pdf-link error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
