// /netlify/functions/download-csv.js

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
    if (!["csv", "report"].includes(tok.type)) {
      return jsonResponse(event.headers?.origin, 403, {
        error: "Token not allowed for CSV download",
      });
    }

    const resolved = await resolveDeliverablesByIds({
      lead_id: tok.lead_id,
      deal_id: tok.deal_id,
    });

    if (!resolved.ok) {
      return jsonResponse(event.headers?.origin, resolved.statusCode || 500, resolved);
    }

    if (!resolved.csv_url) {
      return jsonResponse(event.headers?.origin, 409, { error: "CSV not ready yet" });
    }

    return redirectResponse(event.headers?.origin, resolved.csv_url);
  } catch (err) {
    console.error("download-csv error:", err);
    return jsonResponse(event.headers?.origin, 500, {
      error: String(err?.message || err),
    });
  }
};
