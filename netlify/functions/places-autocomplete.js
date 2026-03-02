// netlify/functions/places-autocomplete.js
// Autocomplete (New) — POST https://places.googleapis.com/v1/places:autocomplete
// Docs: https://developers.google.com/maps/documentation/places/web-service/place-autocomplete

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

function getKey() {
  return (
    process.env.GOOGLE_PLACES_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_KEY ||
    ""
  );
}

function resp(statusCode, obj) {
  return {
    statusCode,
    headers: { ...CORS, "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return resp(405, { error: "Method not allowed" });

  const key = getKey();
  if (!key) return resp(500, { error: "Missing API key env var", hint: "Set GOOGLE_PLACES_API_KEY (recommended)." });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

  const input = String(body.input || "").trim();
  const sessionToken = String(body.sessionToken || "").trim();
  const includedRegionCodes = Array.isArray(body.includedRegionCodes) ? body.includedRegionCodes : ["us"];

  if (!input) return resp(400, { error: "Missing input" });

  try {
    const url = "https://places.googleapis.com/v1/places:autocomplete";

    // Limit response size/cost with a FieldMask
    const fieldMask = [
      "suggestions.placePrediction.placeId",
      "suggestions.placePrediction.text.text",
      "suggestions.placePrediction.structuredFormat.mainText.text",
      "suggestions.placePrediction.structuredFormat.secondaryText.text",
    ].join(",");

    const reqBody = { input, includedRegionCodes };
    if (sessionToken) reqBody.sessionToken = sessionToken;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(reqBody),
    });

    const raw = await r.text();
    if (!r.ok) return resp(r.status, { error: "Google autocomplete failed", detail: raw });

    const json = raw ? JSON.parse(raw) : {};
    const suggestions = Array.isArray(json.suggestions) ? json.suggestions : [];

    // Normalize for landing UI
    const normalized = suggestions
      .map((s) => (s && s.placePrediction ? s.placePrediction : null))
      .filter(Boolean)
      .map((pp) => {
        const primary = pp?.structuredFormat?.mainText?.text || pp?.text?.text || "";
        const secondary = pp?.structuredFormat?.secondaryText?.text || "";
        const fullText = pp?.text?.text || "";
        return {
          placeId: pp.placeId || "",
          primary: String(primary || "").trim(),
          secondary: String(secondary || "").trim(),
          fullText: String(fullText || "").trim(),
        };
      })
      .filter((x) => x.placeId && x.primary);

    return resp(200, { suggestions: normalized });
  } catch (e) {
    return resp(500, { error: "Server error", detail: String(e?.message || e) });
  }
};
