// /netlify/functions/visitor-pdf-link.js
// Backward-compatible secure endpoint returning token-based deliverable JSON

const {
  corsHeaders,
  verifyDownloadToken,
  resolveDeliverablesByIds,
  getTokenFromEvent,
  jsonResponse,
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

    return jsonResponse(event.headers?.origin, 200, {
      ok: true,
      deal_id: resolved.deal_id,
      lead_id: resolved.lead_id,
      pdf_file_id: resolved.pdf_file_id || null,
      pdf_url: resolved.pdf_url || null,
      url: resolved.pdf_url || null,
      csv_file_id: resolved.csv_file_id || null,
      csv_url: resolved.csv_url || null,
      source: "secure_token_visitor_link",
    });
  } catch (err) {
    console.error("visitor-pdf-link error:", err);
    return jsonResponse(event.headers?.origin, 500, {
      error: String(err?.message || err),
    });
  }
};
