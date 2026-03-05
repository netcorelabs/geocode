// netlify/functions/send-visitor-email.js
// FULL DROP-IN REPLACEMENT
//
// Adds missing features:
// 1) Sends "deliverables ready" via HubSpot form submit (keeps your existing automation).
// 2) Updates the HubSpot DEAL:
//    - description: appends a CSV representation of the full payload
//    - hsc_report_pdf_url: set to resolved/received pdf_url
//    - hsc_report_csv_url: set to resolved/received csv_url
//
// Env:
//   HS_DELIVERABLES_PORTAL_ID   (required)  e.g. 245087053
//   HS_DELIVERABLES_FORM_ID     (required)  GUID from the form embed code
//   HUBSPOT_PRIVATE_APP_TOKEN   (required for deal update)
//
// POST JSON (same as before, plus you MUST pass deal_id to update the deal):
// {
//   "email": "visitor@example.com",
//   "firstname": "Bruce",
//   "lastname": "Evans",
//   "lead_id": "uuid",
//   "deal_id": "1234567890",     // REQUIRED for deal patch
//   "pdf_url": "https://...",    // optional (if omitted, resolved via visitor-pdf-link)
//   "csv_url": "https://...",    // optional
//   "pageUri": "https://....",   // optional
//   "legalConsentOptions": {...} // optional (only if your form requires it)
//   ... any other fields (full payload will be included in CSV block)
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
    const allowOrigin = origin
      ? (allowedOrigins.includes(origin) ? origin : allowedOrigins[0])
      : "*";
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
    return {
      statusCode: 405,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  const HS_PORTAL_ID = String(process.env.HS_DELIVERABLES_PORTAL_ID || "").trim();
  const HS_FORM_ID = String(process.env.HS_DELIVERABLES_FORM_ID || "").trim();
  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();

  if (!HS_PORTAL_ID || !HS_FORM_ID) {
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        error: "Missing HS_DELIVERABLES_PORTAL_ID or HS_DELIVERABLES_FORM_ID",
        detail:
          "Create the 'Deliverables Ready' form, then copy portalId + formId(GUID) from the embed code.",
      }),
    };
  }

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

  function getSelfBaseUrl() {
    const host = String(event.headers?.host || "").trim();
    const proto = String(event.headers?.["x-forwarded-proto"] || "https").trim();
    if (host) return `${proto}://${host}`;
    return "https://api.netcoreleads.com";
  }

  function csvEscape(v) {
    const s = String(v ?? "");
    // Escape quotes, wrap in quotes if needed
    const needs = /[",\n\r]/.test(s);
    const escaped = s.replace(/"/g, '""');
    return needs ? `"${escaped}"` : escaped;
  }

  function flattenObject(obj, prefix = "", out = {}) {
    if (!obj || typeof obj !== "object") return out;
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        flattenObject(v, key, out);
      } else if (Array.isArray(v)) {
        out[key] = v.map(x => (typeof x === "object" ? JSON.stringify(x) : String(x))).join("|");
      } else {
        out[key] = v;
      }
    }
    return out;
  }

  function buildPayloadKeyValueCsv(payloadObj) {
    const flat = flattenObject(payloadObj);
    const lines = [];
    lines.push("key,value");
    for (const key of Object.keys(flat).sort()) {
      lines.push(`${csvEscape(key)},${csvEscape(flat[key])}`);
    }
    return lines.join("\n");
  }

  async function resolveLinksViaVisitorFunction({ lead_id, deal_id }) {
    const base = getSelfBaseUrl();
    const qs = new URLSearchParams();
    if (lead_id) qs.set("lead_id", lead_id);
    if (deal_id) qs.set("deal_id", deal_id);

    const url = `${base}/.netlify/functions/visitor-pdf-link?${qs.toString()}`;
    const r = await fetchJson(url, { method: "GET" });

    if (!r.ok) {
      return {
        ok: false,
        statusCode: 502,
        error: "visitor-pdf-link failed",
        status: r.status,
        detail: r.text || r.json,
      };
    }

    const pdf_url = String(r.json?.pdf_url || "").trim();
    const csv_url = String(r.json?.csv_url || "").trim();

    if (!pdf_url) {
      return { ok: false, statusCode: 409, error: "PDF not ready yet", detail: r.json || null };
    }

    return { ok: true, pdf_url, csv_url: csv_url || "" };
  }

  async function submitDeliverablesForm({
    email, firstname, lastname, lead_id, deal_id, pdf_url, csv_url, pageUri, legalConsentOptions,
  }) {
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

    const url =
      `https://api.hsforms.com/submissions/v3/integration/submit/` +
      `${encodeURIComponent(HS_PORTAL_ID)}/${encodeURIComponent(HS_FORM_ID)}`;

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
        detail: r.text || r.json,
      };
    }
    return { ok: true };
  }

  async function getDealDescription(dealId) {
    if (!HS_TOKEN) return { ok: false, status: 0, description: "" };

    const url = `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=description`;
    const r = await fetchJson(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${HS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    if (!r.ok) {
      return { ok: false, status: r.status, description: "" };
    }
    const desc = String(r.json?.properties?.description || "");
    return { ok: true, status: 200, description: desc };
  }

  async function patchDeal({ deal_id, pdf_url, csv_url, payloadCsvBlock }) {
    if (!HS_TOKEN) {
      return {
        ok: false,
        statusCode: 500,
        error: "Missing HUBSPOT_PRIVATE_APP_TOKEN",
        detail: "Set HUBSPOT_PRIVATE_APP_TOKEN in Netlify environment variables to update deals.",
      };
    }
    if (!deal_id) {
      return { ok: false, statusCode: 400, error: "Missing deal_id", detail: "deal_id is required to update deal properties." };
    }

    // Fetch existing description so we can append instead of overwrite
    const existing = await getDealDescription(deal_id);
    const existingDesc = existing.ok ? existing.description : "";

    const stamp = new Date().toISOString();
    const newBlock =
      `\n\n---\n` +
      `HSC Payload CSV (generated ${stamp})\n` +
      `\n` +
      `${payloadCsvBlock}\n` +
      `---\n`;

    const nextDesc = (existingDesc || "").trim() + newBlock;

    const properties = {
      description: nextDesc,
      hsc_report_pdf_url: String(pdf_url || "").trim(),
      hsc_report_csv_url: String(csv_url || "").trim(),
    };

    // Remove empty urls so we don't blank fields accidentally
    if (!properties.hsc_report_pdf_url) delete properties.hsc_report_pdf_url;
    if (!properties.hsc_report_csv_url) delete properties.hsc_report_csv_url;

    const url = `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(deal_id)}`;
    const r = await fetchJson(url, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${HS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties }),
    });

    if (!r.ok) {
      return {
        ok: false,
        statusCode: 502,
        error: "HubSpot deal update failed",
        status: r.status,
        detail: r.text || r.json,
        attempted_properties: properties,
      };
    }

    return { ok: true, updated: r.json };
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
      return {
        statusCode: 400,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Missing email" }),
      };
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
        return {
          statusCode: resolved.statusCode || 500,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify(resolved),
        };
      }

      pdf_url = resolved.pdf_url;
      if (!csv_url) csv_url = resolved.csv_url || "";
    }

    // 1) Submit the form (triggers your email automation)
    const submitted = await submitDeliverablesForm({
      email, firstname, lastname, lead_id, deal_id, pdf_url, csv_url, pageUri, legalConsentOptions,
    });

    if (!submitted.ok) {
      return {
        statusCode: submitted.statusCode || 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify(submitted),
      };
    }

    // 2) Build CSV of the FULL payload and append to the deal description + set deal URLs
    // Include the resolved urls in the CSV too (helpful for audit)
    const payloadForCsv = {
      ...body,
      pdf_url,
      csv_url,
      lead_id: lead_id || body.lead_id || "",
      deal_id: deal_id || body.deal_id || "",
    };
    const payloadCsv = buildPayloadKeyValueCsv(payloadForCsv);

    const dealPatched = await patchDeal({
      deal_id,
      pdf_url,
      csv_url,
      payloadCsvBlock: payloadCsv,
    });

    if (!dealPatched.ok) {
      // We still return 200 if email/form worked, but show deal error clearly
      return {
        statusCode: dealPatched.statusCode || 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          ok: false,
          form_submit_ok: true,
          deal_update_ok: false,
          pdf_url,
          csv_url: csv_url || null,
          deal_error: dealPatched,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        form_submit_ok: true,
        deal_update_ok: true,
        pdf_url,
        csv_url: csv_url || null,
        deal_id: deal_id || null,
      }),
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
