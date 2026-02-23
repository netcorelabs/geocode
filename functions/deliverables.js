// netlify/functions/deliverables.js
export async function handler(event) {
  const deal_id = String(event.queryStringParameters?.deal_id || "").trim();
  const token = String(event.queryStringParameters?.token || "").trim();
  if (!deal_id || !token) return { statusCode: 400, body: "Missing deal_id or token" };

  const baseUrl = (process.env.LEAD_STORE_BASE_URL || "https://www.homesecurecalculator.com").replace(/\/$/,"");
  const pdf = `${baseUrl}/.netlify/functions/download-pdf?deal_id=${encodeURIComponent(deal_id)}&token=${encodeURIComponent(token)}`;
  const csv = `${baseUrl}/.netlify/functions/download-csv?deal_id=${encodeURIComponent(deal_id)}&token=${encodeURIComponent(token)}`;

  return {
    statusCode: 200,
    headers: { "Content-Type":"text/html; charset=utf-8" },
    body: `
      <html><body style="font-family:Inter,Arial,sans-serif;padding:24px;">
        <h2>Lead Deliverables</h2>
        <p><a href="${pdf}">Download PDF</a></p>
        <p><a href="${csv}">Download CSV</a></p>
      </body></html>
    `
  };
}
