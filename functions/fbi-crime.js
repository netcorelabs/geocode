exports.handler = async function(event) {

  const headers = {
  "Access-Control-Allow-Origin": "https://www.homesecurecalculator.com",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS"
};


  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const FBI_KEY = process.env.FBI_API_KEY;
  const { state } = event.queryStringParameters || {};

  if (!state) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "State required" })
    };
  }

  try {

    const response = await fetch(
      `https://api.usa.gov/crime/fbi/sapi/api/summarized/state/${state}/all?api_key=${FBI_KEY}`
    );

    const data = await response.json();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(data)
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "FBI fetch failed" })
    };
  }
};
