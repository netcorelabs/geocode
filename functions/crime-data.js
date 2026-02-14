export async function handler(event) {
  try {
    const { lat, lng } = event.queryStringParameters || {};
    if (!lat || !lng) {
      return response(400, { error: "Missing lat/lng" });
    }

    const res = await fetch(
      `https://crime-data.p.rapidapi.com/crime?lat=${lat}&lng=${lng}&radius=1`,
      {
        headers: {
          "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
          "X-RapidAPI-Host": "crime-data.p.rapidapi.com"
        }
      }
    );

    const data = await res.json();
    const crimes = data?.results || [];

    const weightedScore = calculateCrimeWeight(crimes);

    return response(200, {
      totalCrimes: crimes.length,
      weightedCrimeScore: weightedScore,
      crimes
    });

  } catch (err) {
    return response(500, { error: err.message });
  }
}

function calculateCrimeWeight(crimes) {
  const weights = {
    homicide: 10,
    assault: 7,
    robbery: 6,
    burglary: 5,
    "vehicle theft": 4,
    theft: 3
  };

  return crimes.reduce((score, crime) => {
    const type = (crime.offense || "").toLowerCase();
    for (let key in weights) {
      if (type.includes(key)) return score + weights[key];
    }
    return score + 2;
  }, 0);
}

function response(code, body) {
  return {
    statusCode: code,
    headers: {
      "Access-Control-Allow-Origin": "https://www.homesecurecalculator.com",
      "Access-Control-Allow-Headers": "Content-Type"
    },
    body: JSON.stringify(body)
  };
}
