exports.handler = async function () {

  if (!process.env.GOOGLE_API_KEY) {
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type"
      },
      body: JSON.stringify({
        error: "GOOGLE_API_KEY not configured"
      })
    };
  }

  return {
    statusCode: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type"
    },
    body: JSON.stringify({
      key: process.env.GOOGLE_API_KEY
    })
  };
};
