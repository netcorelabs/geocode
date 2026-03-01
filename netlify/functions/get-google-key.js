// netlify/functions/get-google-key.js

export async function handler(event, context) {
  try {
    // Read the key from an environment variable (never hardcode in code)
    const key = process.env.GOOGLE_MAPS_KEY;

    if (!key) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Google Maps API key is missing" }),
      };
    }

    // Return as JSON
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // allow cross-origin requests
      },
      body: JSON.stringify({ key }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
}
