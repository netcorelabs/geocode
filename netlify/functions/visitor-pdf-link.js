// netlify/functions/visitor-pdf-link.js
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
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    };
  }

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  }
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
  }

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  async function readText(r){ try{ return await r.text(); } catch { return ""; } }
  async function fetchJson(url, options){
    const r = await fetch(url, options);
    const t = await readText(r);
    let j=null; try{ j=t?JSON.parse(t):null; }catch(e){ j=null; }
    return { ok:r.ok, status:r.status, json:j, text:t };
  }

  async function hsGet(path){
    return fetchJson(`https://api.hubapi.com${path}`, { method:"GET", headers: hsAuth });
  }

  try{
    const q = event.queryStringParameters || {};
    const deal_id = String(q.deal_id || "").trim();
    const lead_id = String(q.lead_id || "").trim();

    if (!deal_id && !lead_id) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Provide deal_id or lead_id" }) };
    }

    let dealId = deal_id;

    if (!dealId && lead_id) {
      // find by lead_id (if property exists)
      const search = await fetchJson("https://api.hubapi.com/crm/v3/objects/deals/search", {
        method:"POST",
        headers:{ ...hsAuth, "Content-Type":"application/json" },
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName:"lead_id", operator:"EQ", value: lead_id }] }],
          properties: ["lead_id"],
          limit: 1
        })
      });
      dealId = search.ok ? String(search.json?.results?.[0]?.id || "").trim() : "";
    }

    if (!dealId) {
      return { statusCode: 404, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal not found" }) };
    }

    const r = await hsGet(
      `/crm/v3/objects/deals/${encodeURIComponent(dealId)}` +
      `?properties=deliverable_pdf_url,deliverable_csv_url,deliverable_pdf_file_id,deliverable_csv_file_id,lead_id`
    );

    if (!r.ok) {
      return { statusCode: r.status, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Read deal failed", detail: r.text }) };
    }

    const p = r.json?.properties || {};
    const pdf_url = String(p.deliverable_pdf_url || "").trim();
    const csv_url = String(p.deliverable_csv_url || "").trim();

    if (!pdf_url) {
      // Not ready yet
      return { statusCode: 409, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "PDF not ready yet", deal_id: dealId }) };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        deal_id: dealId,
        lead_id: String(p.lead_id || lead_id || "").trim(),
        pdf_url,
        csv_url,
        pdf_file_id: String(p.deliverable_pdf_file_id || "").trim(),
        csv_file_id: String(p.deliverable_csv_file_id || "").trim()
      })
    };

  } catch(err){
    console.error("visitor-pdf-link error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "visitor-pdf-link failed", detail: String(err?.message || err) }) };
  }
}
