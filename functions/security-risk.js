const fetch = require("node-fetch");

let cache = {};

exports.handler = async function(event) {

  /* ================= CORS HEADERS ================= */

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers,
      body: ""
    };
  }

  /* ================= ENV KEYS ================= */

  const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
  const FBI_KEY = process.env.FBI_API_KEY;

  const { lat, lng, indoorCam, outdoorCam, doorbell, lock } =
    event.queryStringParameters || {};

  if (!lat || !lng) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing coordinates" })
    };
  }

  const cacheKey = `${lat}_${lng}_${indoorCam}_${outdoorCam}_${doorbell}_${lock}`;

  if (cache[cacheKey]) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(cache[cacheKey])
    };
  }

  try {

    /* ================= GOOGLE PLACES ================= */

    const types = ["police","fire_station","hospital"];
    let nearestDistance = 999999;

    for (const type of types) {

      const res = await fetch(
        `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=5000&type=${type}&key=${GOOGLE_KEY}`
      );

      const data = await res.json();

      if (data.results && data.results.length > 0) {

        const place = data.results[0];

        const distRes = await fetch(
          `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${lat},${lng}&destinations=${place.geometry.location.lat},${place.geometry.location.lng}&key=${GOOGLE_KEY}`
        );

        const distData = await distRes.json();

        const meters = distData.rows[0].elements[0].distance.value;

        if (meters < nearestDistance) nearestDistance = meters;
      }
    }

    const responseMinutes = Math.round((nearestDistance/1000)/0.8);

    /* ================= FBI DATA ================= */

    const fbiRes = await fetch(
      `https://api.usa.gov/crime/fbi/sapi/api/summarized/state/ca/all?api_key=${FBI_KEY}`
    );

    const fbiData = await fbiRes.json();

    let violent = 0;
    let property = 0;

    if (fbiData.results) {
      violent = fbiData.results.find(x=>x.offense==="violent-crime")?.actual || 0;
      property = fbiData.results.find(x=>x.offense==="property-crime")?.actual || 0;
    }

    /* ================= BACKEND RISK ENGINE ================= */

    let riskScore = 50;

    riskScore += (Number(indoorCam)||0) * 3;
    riskScore += (Number(outdoorCam)||0) * 4;
    riskScore += (Number(doorbell)||0) * 2;
    riskScore += (Number(lock)||0) * 3;

    if (responseMinutes > 10) riskScore += 10;
    if (violent > property) riskScore += 10;

    riskScore = Math.min(100, riskScore);

    let zone = "Low";
    if (riskScore >= 70) zone = "High";
    else if (riskScore >= 40) zone = "Moderate";

    const exposureScore = Math.floor(Math.random() * 100);

    const result = {
      violent,
      property,
      responseMinutes,
      riskScore,
      exposureScore,
      zone
    };

    cache[cacheKey] = result;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result)
    };

  } catch (err) {

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Risk engine failure" })
    };
  }
};

