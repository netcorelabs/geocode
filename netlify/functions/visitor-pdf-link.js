exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Cache-Control": "no-store",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { ...cors, Allow: "GET,OPTIONS" },
      body: JSON.stringify({ error: "Method Not Allowed. Use GET." }),
    };
  }

  try {
    const url = new URL(event.rawUrl);
    const leadId = (url.searchParams.get("lead_id") || "").trim();
    const email  = (url.searchParams.get("email") || "").trim();

    // If you visit the function directly without params, return 400 (NOT 405)
    if (!leadId && !email) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({
          error: "Missing lead_id or email",
          example: "/.netlify/functions/visitor-pdf-link?lead_id=ABC123&email=test@example.com"
        }),
      };
    }

    // TODO: Replace this stub with your real lookup:
    // - query HubSpot Deal/Contact for hsc_pdf_url / hsc_csv_url
    // For now, returning a clear placeholder prevents silent failures.
    return {
      statusCode: 404,
      headers: cors,
      body: JSON.stringify({
        error: "No PDF URL found yet (lookup not implemented or not saved).",
        lead_id: leadId || null,
        email: email || null
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: "Server error", detail: String(e?.message || e) }),
    };
  }
};
