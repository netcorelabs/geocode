exports.handler = async function (event) {
  try {
    const { state, year } = JSON.parse(event.body || "{}");

    const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

    if (!RAPIDAPI_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing RAPIDAPI_KEY" })
      };
    }

    const response = await fetch(
      `https://api.usa.gov/crime/fbi/sapi/api/summarized/state/${state}/violent-crime/${year}/${year}?api_key=${RAPIDAPI_KEY}`
    );

    const data = await response.json();

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type"
      },
      body: JSON.stringify(data)
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
