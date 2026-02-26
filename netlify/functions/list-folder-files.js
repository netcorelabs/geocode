// netlify/functions/list-folder-files.js
export async function handler(event) {
  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  const folderId = String((event.queryStringParameters || {}).folderId || process.env.HUBSPOT_FILES_FOLDER_ID || "").trim();
  if (!folderId) return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Missing folderId" }) };

  const url = `https://api.hubapi.com/files/v3/files?folderId=${encodeURIComponent(folderId)}&limit=100`;
  const res = await fetch(url, { method: "GET", headers: hsAuth });
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  return {
    statusCode: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ ok: res.ok, folderId, url, json, raw: json ? undefined : text }),
  };
}
