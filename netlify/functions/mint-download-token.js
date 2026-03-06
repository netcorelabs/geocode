// /netlify/functions/mint-download-token.js

const {
  corsHeaders,
  createDownloadToken,
  jsonResponse,
} = require("./_secure-deliverables");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(event.headers?.origin, 405, { error: "Method Not Allowed" });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const lead_id = String(body.lead_id || "").trim();
    const deal_id = String(body.deal_id || "").trim();
    const email = String(body.email || "").trim();
    const type = String(body.type || "report").trim().toLowerCase();

    if (!lead_id && !deal_id) {
      return jsonResponse(event.headers?.origin, 400, { error: "Missing lead_id or deal_id" });
    }

    if (!["pdf", "csv", "report"].includes(type)) {
      return jsonResponse(event.headers?.origin, 400, { error: "Invalid type" });
    }

    const token = createDownloadToken({
      lead_id,
      deal_id,
      email,
      type,
    });

    return jsonResponse(event.headers?.origin, 200, {
      ok: true,
      token,
      type,
    });
  } catch (err) {
    console.error("mint-download-token error:", err);
    return jsonResponse(event.headers?.origin, 500, {
      error: String(err?.message || err),
    });
  }
};
