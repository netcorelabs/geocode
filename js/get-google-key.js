exports.handler = async () => {
  return {
    statusCode: 200,
    headers: {
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify({
      key: process.env.GOOGLE_MAPS_KEY
    })
  };
};
