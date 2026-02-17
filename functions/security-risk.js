exports.handler = async function(event) {

  const headers = {
   "Access-Control-Allow-Origin": "https://www.homesecurecalculator.com"
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

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      status: "security-risk function live",
      timestamp: Date.now()
    })
  };
};



