exports.handler = async () => {
  const key = process.env.GOOGLE_MAPS_API_KEY;

  if (!key) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Google Maps API key is missing" }),
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ key }),
  };
};
