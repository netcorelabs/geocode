// netlify/functions/send-visitor-email.js
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
  const PORTAL_ID = String(process.env.HUBSPOT_PORTAL_ID || "").trim();

  // Default to the form GUID you’ve been using (change any time via env)
  const DEFAULT_FORM_ID = "1988f31c-3916-48a8-aa87-d8aae8a217e2";
  const FORM_ID = String(process.env.HUBSPOT_VISITOR_EMAIL_FORM_ID || DEFAULT_FORM_ID).trim();

  if (!PORTAL_ID) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PORTAL_ID" }) };
  }
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

  async function hsPatchDeal(dealId, properties){
    return fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      method:"PATCH",
      headers:{ ...hsAuth, "Content-Type":"application/json" },
      body: JSON.stringify({ properties })
    });
  }

  // Patch with fallback (ignore unknown deal properties)
  async function patchDealWithFallback(dealId, properties){
    const attempt = async (props)=>hsPatchDeal(dealId, props);
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

  try{
    const body = JSON.parse(event.body || "{}");
    const deal_id = String(body.deal_id || "").trim();
    const lead_id = String(body.lead_id || "").trim();
    const email = String(body.email || "").trim();
    const pdf_url = String(body.pdf_url || "").trim();
    const csv_url = String(body.csv_url || "").trim();

    if (!email) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing email" }) };
    if (!deal_id) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id" }) };
    if (!pdf_url) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing pdf_url" }) };

    // 1) Submit to HubSpot Form (workflow should send email)
    const submitUrl = `https://api.hsforms.com/submissions/v3/integration/submit/${encodeURIComponent(PORTAL_ID)}/${encodeURIComponent(FORM_ID)}`;

    const fields = [
      { name: "email", value: email },
      { name: "lead_id", value: lead_id },
      { name: "deal_id", value: deal_id },
      { name: "hsc_pdf_url", value: pdf_url },
      { name: "hsc_csv_url", value: csv_url },
    ];

    const submit = await fetchJson(submitUrl, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        fields,
        context: { pageUri: body.page_url || "", pageName: body.page_name || "HSRESULTS" }
      })
    });

    // 2) Store links + emailed timestamp on deal (best-effort)
    const nowIso = new Date().toISOString();
    await patchDealWithFallback(deal_id, {
      deliverable_pdf_url: pdf_url,
      deliverable_csv_url: csv_url,
      lead_status: submit.ok ? "Visitor Emailed" : "Visitor Email Attempted",
      visitor_emailed_at: nowIso
    });

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        deal_id,
        lead_id,
        email,
        pdf_url,
        csv_url,
        hubspot_form_ok: submit.ok,
        hubspot_form_status: submit.status,
        hubspot_form_response: submit.ok ? submit.json : submit.text
      })
    };

  } catch(err){
    console.error("send-visitor-email error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "send-visitor-email failed", detail: String(err?.message || err) }) };
  }
}
