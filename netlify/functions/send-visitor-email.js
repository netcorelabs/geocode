// netlify/functions/send-visitor-email.js
// FULL DROP-IN REPLACEMENT
//
// Goal:
// 1) Resolve visitor-ready PDF/CSV URLs (by lead_id or deal_id) using HubSpot Files + Deals.
// 2) Send email in one of two ways:
//    A) If HUBSPOT_TRANSACTIONAL_EMAIL_ID is set -> Transactional Single Send API (requires add-on)
//    B) Else -> Submit a HubSpot Form that triggers an Automated Marketing Email (recommended)
//
// Env req:contentReference[oaicite:7]{index=7}RIVATE_APP_TOKEN
//
// Env (optional) for Transactional:
//   HUBSPOT_TRANSACTIONAL_EMAIL_ID
//
// Env required for Marketing Email path (Form-triggered):
//   HS_DELIVERABLES_PORTAL_ID
//   HS_DELIVERABLES_FORM_ID
//
// Contact properties you should create + add as HIDDEN fields on the form:
//   hsc_report_pdf_url (URL)
//   hsc_report_csv_url (URL) optional
//
// Inputs (POST JSON):
//   {
//     "email": "visitor@example.com",          // or "to"
//     "firstname": "Jane",
//     "lastname": "Doe",
//     "lead_id": "uuid",
//     "deal_id": "123",
//     "pdf_url": "https://...optional",
//     "csv_url": "https://...optional",
//     "pageUri": "https://www.homesecurecalculator.com/hscthankyou", // optional
//     "legalConsentOptions": {...} // optional: pass-through if your form requires it
//   }

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

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
  }

  const TRANSACTIONAL_EMAIL_ID = String(process.env.HUBSPOT_TRANSACTIONAL_EMAIL_ID || "").trim();
  const HS_PORTAL_ID = String(process.env.HS_DELIVERABLES_PORTAL_ID || "").trim();
  const HS_FORM_ID = String(process.env.HS_DELIVERABLES_FORM_ID || "").trim();

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  async function readText(res) {
    try { return await res.text(); } catch { return ""; }
  }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

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

  // Patch deal but ignore missing properties (if portal doesn’t have them)
  async function patchDealWithFallback(dealId, properties) {
    const attempt = async (props) =>
      fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
        method: "PATCH",
        headers: { ...hsAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: props }),
      });

    let r = await attempt(properties);
    if (r.ok) return r;

    const badProps = new Set();
    for (const e of (r.json?.errors || [])) {
      if (e?.code !== "PROPERTY_DOESNT_EXIST") continue;
      const pn = e?.context?.propertyName;
      if (Array.isArray(pn)) pn.forEach((x) => x && badProps.add(String(x)));
      else if (typeof pn === "string" && pn.trim()) badProps.add(pn.trim());
    }

    if (badProps.size) {
      const filtered = Object.fromEntries(Object.entries(properties).filter(([k]) => !badProps.has(k)));
      if (Object.keys(filtered).length) return attempt(filtered);
    }
    return r;
  }

  async function findDealByLeadId(leadId) {
    // 1) Exact match on lead_id property
    const exact = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id", "deliverable_pdf_file_id", "deliverable_csv_file_id", "deliverable_pdf_url", "deliverable_csv_url"],
      sorts: ["-hs_lastmodifieddate"],
      limit: 1,
    });
    if (exact.ok && exact.json?.results?.[0]) return exact.json.results[0];

    // 2) Fallback: dealname contains leadId
    const contains = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "dealname", operator: "CONTAINS_TOKEN", value: leadId }] }],
      properties: ["lead_id", "deliverable_pdf_file_id", "deliverable_csv_file_id", "deliverable_pdf_url", "deliverable_csv_url"],
      sorts: ["-hs_lastmodifieddate"],
      limit: 1,
    });
    return (contains.ok && contains.json?.results?.[0]) ? contains.json.results[0] : null;
  }

  async function readDealById(dealId) {
    const r = await hsGet(
      `/crm/v3/objects/deals/${encodeURIComponent(dealId)}` +
      `?properties=lead_id,deliverable_pdf_file_id,deliverable_csv_file_id,deliverable_pdf_url,deliverable_csv_url`
    );
    return (r.ok && r.json?.id) ? r.json : null;
  }

  async function readFile(fileId) {
    const r = await hsGet(`/files/v3/files/${encodeURIComponent(fileId)}`);
    return (r.ok && r.json?.id) ? r.json : null;
  }

  async function createSignedUrl(fileId) {
    const r = await hsGet(`/files/v3/files/${encodeURIComponent(fileId)}/signed-url`);
    const url = String(r.json?.url || "").trim();
    return (r.ok && url) ? { ok: true, url } : { ok: false, status: r.status, text: r.text || "Failed to create signed URL" };
  }

  async function bestUrl(fileId) {
    const file = await readFile(fileId);
    const access = String(file?.access || "").toUpperCase();
    const hosting = String(file?.defaultHostingUrl || file?.url || "").trim();

    // Prefer public hosting URLs (best for emails — no expiration)
    if (hosting && access.startsWith("PUBLIC")) return { ok: true, url: hosting, mode: "hosting", public: true };

    // Fallback to signed URL (may expire)
    const signed = await createSignedUrl(fileId);
    if (signed.ok) return { ok: true, url: signed.url, mode: "signed", public: false };

    return { ok: false, url: "", mode: "none", detail: signed.text || "No URL available" };
  }

  async function resolveDeliverableLinks({ lead_id, deal_id }) {
    let deal = null;
    if (deal_id) deal = await readDealById(deal_id);
    if (!deal && lead_id) deal = await findDealByLeadId(lead_id);

    if (!deal?.id) {
      return { ok: false, statusCode: 404, error: "Deal not found", deal_id, lead_id };
    }

    const dealId = String(deal.id);
    const props = deal.properties || {};

    let pdfUrlStored = String(props.deliverable_pdf_url || "").trim();
    let csvUrlStored = String(props.deliverable_csv_url || "").trim();

    const pdfFileId = String(props.deliverable_pdf_file_id || "").trim();
    const csvFileId = String(props.deliverable_csv_file_id || "").trim();

    // Resolve PDF
    if (!pdfUrlStored) {
      if (!pdfFileId) return { ok: false, statusCode: 409, error: "PDF not ready yet", deal_id: dealId, lead_id: String(props.lead_id || lead_id || "").trim() };
      const pdfBest = await bestUrl(pdfFileId);
      if (!pdfBest.ok) return { ok: false, statusCode: 500, error: "Failed to create visitor PDF URL", detail: pdfBest.detail || "unknown", deal_id: dealId };
      pdfUrlStored = pdfBest.url;

      // Cache only PUBLIC URLs (don’t persist expiring signed URLs)
      if (pdfBest.public) await patchDealWithFallback(dealId, { deliverable_pdf_url: pdfUrlStored });
    }

    // Resolve CSV (optional)
    if (!csvUrlStored && csvFileId) {
      const csvBest = await bestUrl(csvFileId);
      if (csvBest.ok) {
        csvUrlStored = csvBest.url;
        if (csvBest.public) await patchDealWithFallback(dealId, { deliverable_csv_url: csvUrlStored });
      }
    }

    return {
      ok: true,
      deal_id: dealId,
      lead_id: String(props.lead_id || lead_id || "").trim(),
      pdf_url: pdfUrlStored,
      csv_url: csvUrlStored || null,
    };
  }

  async function sendTransactionalEmail({ to, firstname, lastname, pdf_url, csv_url, lead_id, deal_id }) {
    const r = await fetchJson("https://api.hubapi.com/marketing/v3/transactional/single-email/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        emailId: Number(TRANSACTIONAL_EMAIL_ID),
        message: { to },
        contactProperties: {
          email: to,
          ...(firstname ? { firstname } : {}),
          ...(lastname ? { lastname } : {}),
        },
        customProperties: {
          pdf_url,
          ...(csv_url ? { csv_url } : {}),
          ...(lead_id ? { lead_id } : {}),
          ...(deal_id ? { deal_id } : {}),
        },
      }),
    });

    if (!r.ok) {
      return {
        ok: false,
        statusCode: 502,
        error: "HubSpot transactional email send failed",
        status: r.status,
        detail: r.text || JSON.stringify(r.json),
      };
    }
    return { ok: true };
  }

  async function submitDeliverablesForm({ to, firstname, lastname, pdf_url, csv_url, lead_id, deal_id, pageUri, legalConsentOptions }) {
    if (!HS_PORTAL_ID || !HS_FORM_ID) {
      return {
        ok: false,
        statusCode: 501,
        error: "Marketing email path not configured",
        detail: "Set HS_DELIVERABLES_PORTAL_ID and HS_DELIVERABLES_FORM_ID env vars (a HubSpot Form that triggers the automated marketing email).",
      };
    }

    // Fields MUST exist on the form (add as hidden fields), or HubSpot will ignore them.
    const fields = [
      { name: "email", value: to },
      ...(firstname ? [{ name: "firstname", value: firstname }] : []),
      ...(lastname ? [{ name: "lastname", value: lastname }] : []),
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
      return {
        ok: false,
        statusCode: 502,
        error: "HubSpot form submit failed",
        status: r.status,
        detail: r.text || JSON.stringify(r.json),
      };
    }

    return { ok: true };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const to = String(body.to || body.email || "").trim();
    const firstname = String(body.firstname || "").trim();
    const lastname = String(body.lastname || "").trim();

    let pdf_url = String(body.pdf_url || "").trim();
    let csv_url = String(body.csv_url || "").trim();

    const lead_id = String(body.lead_id || "").trim();
    const deal_id = String(body.deal_id || "").trim();

    const pageUri = String(body.pageUri || "").trim() || undefined;
    const legalConsentOptions = body.legalConsentOptions || undefined;

    if (!to) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing email/to" }) };
    }

    // If caller didn't pass pdf_url, resolve it from deal by lead_id/deal_id
    let resolvedDealId = deal_id || "";
    if (!pdf_url) {
      const resolved = await resolveDeliverableLinks({ lead_id, deal_id });
      if (!resolved.ok) {
        return { statusCode: resolved.statusCode || 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify(resolved) };
      }
      pdf_url = resolved.pdf_url;
      csv_url = resolved.csv_url || csv_url;
      resolvedDealId = resolved.deal_id;
    }

    if (!pdf_url) {
      return { statusCode: 409, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "PDF not ready yet" }) };
    }

    // PATH A: Transactional (if configured)
    if (TRANSACTIONAL_EMAIL_ID) {
      const sent = await sendTransactionalEmail({
        to,
        firstname,
        lastname,
        pdf_url,
        csv_url,
        lead_id,
        deal_id: resolvedDealId || deal_id,
      });

      if (!sent.ok) {
        return { statusCode: sent.statusCode || 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify(sent) };
      }

      return {
        statusCode: 200,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ ok: true, mode: "transactional", pdf_url, csv_url: csv_url || null }),
      };
    }

    // PATH B: Marketing Email (via HubSpot Form automation)
    const submitted = await submitDeliverablesForm({
      to,
      firstname,
      lastname,
      pdf_url,
      csv_url,
      lead_id,
      deal_id: resolvedDealId || deal_id,
      pageUri,
      legalConsentOptions,
    });

    if (!submitted.ok) {
      return { statusCode: submitted.statusCode || 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify(submitted) };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ ok: true, mode: "marketing_email_via_form", pdf_url, csv_url: csv_url || null }),
    };
  } catch (err) {
    console.error("send-visitor-email error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: String(err?.message || err) }),
    };
  }
}
