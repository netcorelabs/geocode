export async function handler(event) {

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(event.headers.origin), body: "" };
  }

  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: corsHeaders(event.headers.origin), body: "Method Not Allowed" };
  }

  try {
    const { lat, lng } = event.queryStringParameters || {};
    if (!lat || !lng) return { statusCode: 400, headers: corsHeaders(event.headers.origin), body: JSON.stringify({ error: "Missing lat/lng" }) };

    const res = await fetch(`https://crime-data.p.rapidapi.com/crime?lat=${lat}&lng=${lng}&radius=1`, {
      headers: {
        "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
        "X-RapidAPI-Host": "crime-data.p.rapidapi.com"
      }
    });

    const data = await res.json();
    const crimes = data?.results || [];

    const weightedScore = calculateCrimeWeight(crimes);

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers.origin),
      body: JSON.stringify({
        totalCrimes: crimes.length,
        weightedCrimeScore: weightedScore,
        crimes,
        riskLevel: determineRisk(weightedScore)
      })
    };

  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(event.headers.origin), body: JSON.stringify({ error: err.message }) };
  }
};

function calculateCrimeWeight(crimes) {
  const weights = { homicide:10, assault:7, robbery:6, burglary:5, "vehicle theft":4, theft:3 };
  return crimes.reduce((score, crime) => {
    const type = (crime.offense || "").toLowerCase();
    for (let key in weights) if (type.includes(key)) return score + weights[key];
    return score + 2;
  },0);
}

function determineRisk(score) {
  if(score<20) return "Low";
  if(score<50) return "Moderate";
  if(score<100) return "High";
  return "Severe";
}

function corsHeaders(origin) {
  const allowedOrigins = ["https://www.homesecurecalculator.com","https://hubspotgate.netlify.app"];
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };
}
