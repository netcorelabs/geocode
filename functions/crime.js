exports.handler = async function (event) {
  try {
    const { state = "GA", year = "2022" } = event.queryStringParameters || {};

    const apiKey = process.env.FBI_API_KEY;

    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "FBI API key not configured" }),
      };
    }

    const url = `https://api.usa.gov/crime/fbi/sapi/api/summarized/state/${state}/violent-crime/${year}/${year}?api_key=${apiKey}`;

    const response = await fetch(url);
    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify(data),
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Crime API failed", details: error.message }),
    };
  }
};
