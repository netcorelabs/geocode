// /netlify/functions/download-report.js

const {
  corsHeaders,
  verifyDownloadToken,
  resolveDeliverablesByIds,
  getTokenFromEvent,
  jsonResponse,
  redirectResponse,
} = require("./_secure-deliverables");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  }

  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return jsonResponse(event.headers?.origin, 405, { error: "Method Not Allowed" });
  }

  try {
    const token = getTokenFromEvent(event);
    const verified = verifyDownloadToken(token);

    if (!verified.ok) {
      return jsonResponse(event.headers?.origin, 403, { error: verified.error });
    }

    const tok = verified.payload;
    const resolved = await resolveDeliverablesByIds({
      lead_id: tok.lead_id,
      deal_id: tok.deal_id,
    });

    if (!resolved.ok) {
      return jsonResponse(event.headers?.origin, resolved.statusCode || 500, resolved);
    }

    if (tok.type === "pdf") {
      if (!resolved.pdf_url) {
        return jsonResponse(event.headers?.origin, 409, { error: "PDF not ready yet" });
      }
      return redirectResponse(event.headers?.origin, resolved.pdf_url);
    }

    if (tok.type === "csv") {
      if (!resolved.csv_url) {
        return jsonResponse(event.headers?.origin, 409, { error: "CSV not ready yet" });
      }
      return redirectResponse(event.headers?.origin, resolved.csv_url);
    }

    return jsonResponse(event.headers?.origin, 200, {
      ok: true,
      token_type: tok.type,
      deal_id: resolved.deal_id,
      lead_id: resolved.lead_id,
      pdf_url: resolved.pdf_url || null,
      csv_url: resolved.csv_url || null,
      url: resolved.pdf_url || null,
      source: "secure_token_download_report",
    });
  } catch (err) {
    console.error("download-report error:", err);
    return jsonResponse(event.headers?.origin, 500, {
      error: String(err?.message || err),
    });
  }
};
