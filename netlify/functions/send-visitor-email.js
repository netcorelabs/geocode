// /netlify/functions/send-visitor-email.js

const {
  corsHeaders,
  createDownloadToken,
  resolveDeliverablesByIds,
} = require("./_secure-deliverables");

exports.handler = async (event) => {
  function json(statusCode, bodyObj) {
    return {
      statusCode,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify(bodyObj),
    };
  }

  async function readText(res) {
    try { return await res.text(); } catch { return ""; }
  }

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: res.ok, status: res.status, json, text };
  }

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method Not Allowed" });
  }

  try {
    const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
    if (!HS_TOKEN) {
      return json(500, { error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" });
    }

    const TRANSACTIONAL_EMAIL_ID = String(process.env.HUBSPOT_TRANSACTIONAL_EMAIL_ID || "").trim();
    const HS_PORTAL_ID = String(process.env.HS_DELIVERABLES_PORTAL_ID || "").trim();
    const HS_FORM_ID = String(process.env.HS_DELIVERABLES_FORM_ID || "").trim();

    const body = JSON.parse(event.body || "{}");

    const to = String(body.to || body.email || "").trim();
    const firstname = String(body.firstname || "").trim();
    const lastname = String(body.lastname || "").trim();
    const lead_id = String(body.lead_id || "").trim();
    const deal_id = String(body.deal_id || "").trim();
    const pageUri = String(body.pageUri || "https://www.homesecurecalculator.com/hscthankyou").trim();
    const legalConsentOptions = body.legalConsentOptions || null;

    if (!to) return json(400, { error: "Missing email" });
    if (!lead_id && !deal_id) return json(400, { error: "Missing lead_id or deal_id" });

    const resolved = await resolveDeliverablesByIds({ lead_id, deal_id });
    if (!resolved.ok) {
      return json(resolved.statusCode || 500, resolved);
    }

    const tokenReport = createDownloadToken({
      lead_id: resolved.lead_id,
      deal_id: resolved.deal_id,
      email: to,
      type: "report",
    });

    const tokenPdf = createDownloadToken({
      lead_id: resolved.lead_id,
      deal_id: resolved.deal_id,
      email: to,
      type: "pdf",
    });

    const tokenCsv = createDownloadToken({
      lead_id: resolved.lead_id,
      deal_id: resolved.deal_id,
      email: to,
      type: "csv",
    });

    const base = "https://api.netcoreleads.com/.netlify/functions";
    const report_url = `${base}/download-report?token=${encodeURIComponent(tokenReport)}`;
    const pdf_url = `${base}/download-pdf?token=${encodeURIComponent(tokenPdf)}`;
    const csv_url = resolved.csv_url
      ? `${base}/download-csv?token=${encodeURIComponent(tokenCsv)}`
      : "";

    async function sendTransactionalEmail() {
      const r = await fetchJson("https://api.hubapi.com/marketing/v3/transactional/single-email/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          emailId: Number(TRANSACTIONAL_EMAIL_ID),
          message: { to },
          contactProperties: {
            email: to,
            ...(firstname ? { firstname } : {}),
            ...(lastname ? { lastname } : {}),
          },
          customProperties: {
            report_url,
            pdf_url,
            ...(csv_url ? { csv_url } : {}),
            ...(resolved.lead_id ? { lead_id: resolved.lead_id } : {}),
            ...(resolved.deal_id ? { deal_id: resolved.deal_id } : {}),
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

    async function submitDeliverablesForm() {
      if (!HS_PORTAL_ID || !HS_FORM_ID) {
        return {
          ok: false,
          statusCode: 501,
          error: "Marketing email path not configured",
          detail: "Set HS_DELIVERABLES_PORTAL_ID and HS_DELIVERABLES_FORM_ID.",
        };
      }

      const fields = [
        { name: "email", value: to },
        ...(firstname ? [{ name: "firstname", value: firstname }] : []),
        ...(lastname ? [{ name: "lastname", value: lastname }] : []),
        { name: "hsc_report_url", value: report_url },
        { name: "hsc_report_pdf_url", value: pdf_url },
        ...(csv_url ? [{ name: "hsc_report_csv_url", value: csv_url }] : []),
        ...(resolved.lead_id ? [{ name: "lead_id", value: resolved.lead_id }] : []),
        ...(resolved.deal_id ? [{ name: "deal_id", value: resolved.deal_id }] : []),
      ];

      const payload = {
        fields,
        context: {
          pageUri,
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

    if (TRANSACTIONAL_EMAIL_ID) {
      const sent = await sendTransactionalEmail();
      if (!sent.ok) return json(sent.statusCode || 500, sent);

      return json(200, {
        ok: true,
        mode: "transactional",
        report_url,
        pdf_url,
        csv_url: csv_url || null,
      });
    }

    const submitted = await submitDeliverablesForm();
    if (!submitted.ok) return json(submitted.statusCode || 500, submitted);

    return json(200, {
      ok: true,
      mode: "marketing_email_via_form",
      report_url,
      pdf_url,
      csv_url: csv_url || null,
    });
  } catch (err) {
    console.error("send-visitor-email error:", err);
    return json(500, { error: String(err?.message || err) });
  }
};
