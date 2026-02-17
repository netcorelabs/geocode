exports.handler = async function (event) {

  // ===== CORS Preflight Support =====
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "https://www.homesecurecalculator.com"
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Method Not Allowed" })
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const state = body.state || "GA";
    const year = body.year || "2022";

    if (!/^[A-Z]{2}$/.test(state)) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "Invalid state format" })
      };
    }

    const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

    if (!RAPIDAPI_KEY) {
      return {
        statusCode: 500,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "Missing RAPIDAPI_KEY environment variable" })
      };
    }

    const apiUrl =
      `https://api.usa.gov/crime/fbi/sapi/api/summarized/state/${state}/violent-crime/${year}/${year}?api_key=${RAPIDAPI_KEY}`;

    const response = await fetch(apiUrl);

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: corsHeaders(),
        body: JSON.stringify({
          error: "Crime API request failed",
          status: response.status
        })
      };
    }

    const data = await response.json();

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(),
        "Cache-Control": "public, max-age=3600" // 1 hour caching
      },
      body: JSON.stringify({
        success: true,
        results: data.results || []
      })
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: "Server error",
        message: error.message
      })
    };
  }
};

// ===== Reusable CORS Headers =====
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}
