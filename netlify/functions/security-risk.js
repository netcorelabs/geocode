// netlify/functions/security-risk.js

exports.handler = async (event) => {

  /* ===============================
     CORS HEADERS
  =============================== */
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET"
  };

  try {

    /* ===============================
       INPUTS
    =============================== */

    const {
      lat,
      lng,
      indoorCam = 0,
      outdoorCam = 0,
      doorbell = 0,
      lock = 0,
      zip
    } = event.queryStringParameters;

    if (!lat || !lng || !zip) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing lat/lng/zip" })
      };
    }

    /* ===============================
       1️⃣ INCOME DATA (RapidAPI)
    =============================== */

    let medianIncome = 60000; // fallback default

    try {
      const incomeRes = await fetch(
        `https://household-income-by-zip-code.p.rapidapi.com/v1/Census/HouseholdIncomeByZip/${zip}`,
        {
          headers: {
            "x-rapidapi-key": process.env.RAPIDAPI_KEY,
            "x-rapidapi-host": "household-income-by-zip-code.p.rapidapi.com"
          }
        }
      );

      const incomeData = await incomeRes.json();

      if (incomeData && incomeData.data && incomeData.data[0]) {
        medianIncome = incomeData.data[0].medianHouseholdIncome || medianIncome;
      }

    } catch (e) {
      console.log("Income API fallback");
    }

    /* ===============================
       2️⃣ CRIME INDEX (SIMPLIFIED FBI RATE MODEL)
    =============================== */

    // Replace with your cached FBI call if needed
    const nationalAverageCrimeRate = 380; // per 100k
    const stateCrimeRate = 420; // replace with FBI API if desired

    const crimeIndex = (stateCrimeRate / nationalAverageCrimeRate) * 100;

    /* ===============================
       3️⃣ RESPONSE TIME ESTIMATE
    =============================== */

    const avgDistanceKm = 4; // assume from Places proxy if integrated
    let responseScore;

    if (avgDistanceKm < 3) responseScore = 20;
    else if (avgDistanceKm < 6) responseScore = 15;
    else if (avgDistanceKm < 10) responseScore = 10;
    else responseScore = 5;

    /* ===============================
       4️⃣ EXPOSURE MODEL
    =============================== */

    const exposureScore = Math.min(
      100,
      Math.round(
        (Math.random() * 40) + 40 // placeholder until CV model
      )
    );

    /* ===============================
       5️⃣ SYSTEM MITIGATION
    =============================== */

    const mitigationScore =
      (indoorCam * 2) +
      (outdoorCam * 4) +
      (doorbell * 2) +
      (lock * 3);

    /* ===============================
       6️⃣ INCOME RISK FACTOR
    =============================== */

    // Lower income ZIP = higher risk
    const nationalMedianIncome = 70000;

    const incomeFactor =
      100 - Math.min(
        100,
        (medianIncome / nationalMedianIncome) * 100
      );

    /* ===============================
       7️⃣ FINAL WEIGHTED SCORE
    =============================== */

    let finalScore =
      (crimeIndex * 0.35) +
      (responseScore * 0.20) +
      (exposureScore * 0.20) +
      (incomeFactor * 0.15) -
      (mitigationScore * 0.10);

    finalScore = Math.max(10, Math.min(100, Math.round(finalScore)));

    /* ===============================
       RISK ZONE CLASSIFICATION
    =============================== */

    let zone;

    if (finalScore < 40) zone = "Low";
    else if (finalScore < 60) zone = "Moderate";
    else if (finalScore < 75) zone = "Elevated";
    else if (finalScore < 90) zone = "High";
    else zone = "Severe";

    /* ===============================
       VENDOR LEAD MONETIZATION SCORE
    =============================== */

    let leadScore =
      (finalScore * 0.4) +
      (mitigationScore * 0.3) +
      (incomeFactor * 0.3);

    leadScore = Math.round(Math.min(100, leadScore));

    let leadTier;
    let leadPrice;

    if (leadScore >= 80) {
      leadTier = "Premium";
      leadPrice = 55;
    } else if (leadScore >= 60) {
      leadTier = "High";
      leadPrice = 40;
    } else if (leadScore >= 40) {
      leadTier = "Standard";
      leadPrice = 25;
    } else {
      leadTier = "Basic";
      leadPrice = 15;
    }

    /* ===============================
       RESPONSE
    =============================== */

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        riskScore: finalScore,
        zone,
        crimeIndex: Math.round(crimeIndex),
        responseScore,
        exposureScore,
        mitigationScore,
        medianIncome,
        incomeFactor,
        leadScore,
        leadTier,
        leadPrice
      })
    };

  } catch (error) {

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Risk engine failure" })
    };

  }
};
