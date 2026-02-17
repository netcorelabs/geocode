const fetch = require("node-fetch");

exports.handler = async function(event) {

  const FBI_KEY = process.env.FBI_API_KEY;

  const { state } = event.queryStringParameters || {};

  if (!state) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "State is required" })
    };
  }

  try {

    const response = await fetch(
      `https://api.usa.gov/crime/fbi/sapi/api/summarized/state/${state}/all?api_key=${FBI_KEY}`
    );

    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify(data)
    };

  } catch (error) {

    return {
      statusCode: 500,
      body: JSON.stringify({ error: "FBI API fetch failed" })
    };

  }
};


 
