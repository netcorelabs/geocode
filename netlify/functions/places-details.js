// netlify/functions/places-details.js
// Calls: https://places.googleapis.com/v1/places/PLACE_ID (GET)  :contentReference[oaicite:4]{index=4}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

function getApiKey() {
  return (
    process.env.GOOGLE_PLACES_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_KEY ||
    ""
  );
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const API_KEY = getApiKey();
  if (!API_KEY) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Missing GOOGLE_PLACES_API_KEY (or GOOGLE_MAPS_API_KEY)" }) };
  }

  const qs = event.queryStringParameters || {};
  const placeId = String(qs.placeId || "").trim();
  const sessionToken = String(qs.sessionToken || "").trim();

  if (!placeId) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Missing placeId" }) };
  }

  try {
    let url = "https://places.googleapis.com/v1/places/" + encodeURIComponent(placeId);

    // sessionToken is listed as an optional parameter for Place Details (New) :contentReference[oaicite:5]{index=5}
    if (sessionToken) {
      url += "?sessionToken=" + encodeURIComponent(sessionToken);
    }

    const r = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": API_KEY,
        // Place Details requires a FieldMask, no default fields :contentReference[oaicite:6]{index=6}
        "X-Goog-FieldMask": "formattedAddress,addressComponents",
      },
    });

    const text = await r.text();
    if (!r.ok) {
      return { statusCode: r.status, headers: cors, body: JSON.stringify({ error: "Google place details failed", detail: text }) };
    }

    const json = text ? JSON.parse(text) : {};
    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        formattedAddress: json.formattedAddress || "",
        addressComponents: Array.isArray(json.addressComponents) ? json.addressComponents : [],
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Server error", detail: String(e?.message || e) }) };
  }
};
