// netlify/functions/send-visitor-email.js
// FULL DROP-IN REPLACEMENT (Marketing Email via HubSpot Form automation)
//
// What it does:
// 1) Resolves the visitor PDF/CSV URL by calling your existing visitor-pdf-link function.
// 2) Writes those URLs onto the contact by submitting a HubSpot Form (hidden fields).
// 3) That form's automation sends your marketing email ("Your Home Security Report is ready").
//
// Env:
//   HS_DELIVERABLES_PORTAL_ID   (required)  e.g. 245087053
//   HS_DELIVERABLES_FORM_ID     (required)  GUID from the form embed code
//
// POST JSON:
// {
//   "email": "visitor@example.com",
//   "firstname": "Bruce",
//   "lastname": "Evans",
//   "lead_id": "uuid",          // recommended
//   "deal_id": "123",           // optional
//   "pdf_url": "https://...",   // optional (if omitted, we resolve via visitor-pdf-link)
//   "csv_url": "https://...",   // optional
//   "pageUri": "https://....",  // optional
//   "legalConsentOptions": {...} // optional (only if your form requires it)
// }

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
    return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const HS_PORTAL_ID = String(process.env.HS_DELIVERABLES_PORTAL_ID || "").trim();
  const HS_FORM_ID = String(process.env.HS_DELIVERABLES_FORM_ID || "").trim();
  if (!HS_PORTAL_ID || !HS_FORM_ID) {
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        error: "Missing HS_DELIVERABLES_PORTAL_ID or HS_DELIVERABLES_FORM_ID",
        detail: "Create the 'Deliverables Ready' form, then copy portalId + formId(GUID) from the embed code.",
      }),
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

  function getSelfBaseUrl() {
    const host = String(event.headers?.host || "").trim();
    const proto = String(event.headers?.["x-forwarded-proto"] || "https").trim();
    if (host) return `${proto}://${host}`;
    // fallback (should rarely happen)
    return "https://api.netcoreleads.com";
  }

  async function resolveLinksViaVisitorFunction({ lead_id, deal_id }) {
    const base = getSelfBaseUrl();
    const qs = new URLSearchParams();
    if (lead_id) qs.set("lead_id", lead_id);
    if (deal_id) qs.set("deal_id", deal_id);

    const url = `${base}/.netlify/functions/visitor-pdf-link?${qs.toString()}`;
    const r = await fetchJson(url, { method: "GET" });

    if (!r.ok) {
      return { ok: false, statusCode: 502, error: "visitor-pdf-link failed", status: r.status, detail: r.text || r.json };
    }

    const pdf_url = String(r.json?.pdf_url || "").trim();
    const csv_url = String(r.json?.csv_url || "").trim();

    if (!pdf_url) {
      return { ok: false, statusCode: 409, error: "PDF not ready yet", detail: r.json || null };
    }

    return { ok: true, pdf_url, csv_url: csv_url || "" };
  }

  async function submitDeliverablesForm({ email, firstname, lastname, lead_id, deal_id, pdf_url, csv_url, pageUri, legalConsentOptions }) {
    const fields = [
      { name: "email", value: email },
      ...(firstname ? [{ name: "firstname", value: firstname }] : []),
      ...(lastname ? [{ name: "lastname", value: lastname }] : []),
      // MUST exist as hidden fields on the form:
      { name: "hsc_report_pdf_url", value: pdf_url },
      ...(csv_url ? [{ name: "hsc_report_csv_url", value: csv_url }] : []),
      ...(lead_id ? [{ name: "lead_id", value: lead_id }] : []),
      ...(deal_id ? [{ name: "deal_id", value: deal_id }] : []),
    ];

    const payload = {
      fields,
      context: {
        pageUri: pageUri || "https://www.homesecurecalculator.com/hscthankyou",
        pageName: "HSC Deliverables Ready",
      },
      ...(legalConsentOptions ? { legalConsentOptions } : {}),
    };

    const url = `https://api.hsforms.com/submissions/v3/integration/submit/${encodeURIComponent(HS_PORTAL_ID)}/${encodeURIComponent(HS_FORM_ID)}`;
    const r = await fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      return { ok: false, statusCode: 502, error: "HubSpot form submit failed", status: r.status, detail: r.text || r.json };
    }
    return { ok: true };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const email = String(body.email || body.to || "").trim();
    const firstname = String(body.firstname || "").trim();
    const lastname = String(body.lastname || "").trim();
    const lead_id = String(body.lead_id || "").trim();
    const deal_id = String(body.deal_id || "").trim();

    let pdf_url = String(body.pdf_url || "").trim();
    let csv_url = String(body.csv_url || "").trim();

    const pageUri = String(body.pageUri || "").trim() || undefined;
    const legalConsentOptions = body.legalConsentOptions || undefined;

    if (!email) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing email" }) };
    }

    // If pdf_url not provided, resolve via your visitor-pdf-link function
    if (!pdf_url) {
      if (!lead_id && !deal_id) {
        return {
          statusCode: 400,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({ error: "Missing pdf_url AND missing lead_id/deal_id to resolve it" }),
        };
      }
      const resolved = await resolveLinksViaVisitorFunction({ lead_id, deal_id });
      if (!resolved.ok) {
        return { statusCode: resolved.statusCode || 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify(resolved) };
      }
      pdf_url = resolved.pdf_url;
      if (!csv_url) csv_url = resolved.csv_url || "";
    }

    // Submit the form (this triggers your marketing email automation)
    const submitted = await submitDeliverablesForm({
      email,
      firstname,
      lastname,
      lead_id,
      deal_id,
      pdf_url,
      csv_url,
      pageUri,
      legalConsentOptions,
    });

    if (!submitted.ok) {
      return { statusCode: submitted.statusCode || 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify(submitted) };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        mode: "marketing_email_via_form",
        pdf_url,
        csv_url: csv_url || null,
      }),
    };
  } catch (err) {
    console.error("send-visitor-email error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
