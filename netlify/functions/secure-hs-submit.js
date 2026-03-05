// netlify/functions/secure-hs-submit.js
// FULL DROP-IN
//
// Env vars required:
//   RECAPTCHA_V3_SECRET           (required)  -> your Google reCAPTCHA v3 secret key
//
// Optional env vars:
//   RECAPTCHA_V3_MIN_SCORE        (default 0.5)
//   RECAPTCHA_V3_EXPECT_ACTION    (default "hsc_landing_submit")
//
// Request body (POST JSON) from landing page:
// {
//   honeypot: "",
//   recaptcha_token: "...",
//   recaptcha_action: "hsc_landing_submit",
//   portalId: "245087053",
//   formId: "....",
//   fields: { firstname, lastname, email, phone, address, city, state, zip, country },
//   context: { pageUri, pageName }
// }

export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ ok:false, error: "Method Not Allowed" }) };
  }

  const RECAPTCHA_SECRET = String(process.env.RECAPTCHA_V3_SECRET || "").trim();
  const MIN_SCORE = Number(process.env.RECAPTCHA_V3_MIN_SCORE || "0.5");
  const EXPECT_ACTION = String(process.env.RECAPTCHA_V3_EXPECT_ACTION || "hsc_landing_submit").trim();

  if (!RECAPTCHA_SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok:false, error: "Missing RECAPTCHA_V3_SECRET" }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const honeypot = String(body.honeypot || "").trim();
  // ✅ Honeypot triggered — silently accept but do nothing
  if (honeypot) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok:true, dropped:true }) };
  }

  const token = String(body.recaptcha_token || "").trim();
  const action = String(body.recaptcha_action || "").trim() || "";
  const portalId = String(body.portalId || "").trim();
  const formId = String(body.formId || "").trim();
  const fields = body.fields || {};
  const context = body.context || {};

  if (!token) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok:false, error: "Missing recaptcha_token" }) };
  }
  if (!portalId || !formId) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok:false, error: "Missing portalId/formId" }) };
  }

  async function readText(res){ try { return await res.text(); } catch { return ""; } }

  // ✅ Verify reCAPTCHA with Google
  const verifyBody = new URLSearchParams();
  verifyBody.set("secret", RECAPTCHA_SECRET);
  verifyBody.set("response", token);
  // Optional: verifyBody.set("remoteip", event.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "");

  const v = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: verifyBody.toString()
  });

  const vText = await readText(v);
  let vJson = null;
  try { vJson = vText ? JSON.parse(vText) : null; } catch { vJson = null; }

  if (!v.ok || !vJson) {
    return { statusCode: 502, headers, body: JSON.stringify({ ok:false, error:"reCAPTCHA verify failed", detail: vText || null }) };
  }

  const success = !!vJson.success;
  const score = Number(vJson.score ?? 0);
  const vAction = String(vJson.action || "");

  if (!success) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok:false, error:"Blocked by reCAPTCHA", reason: vJson["error-codes"] || [] }) };
  }
  if (EXPECT_ACTION && vAction && vAction !== EXPECT_ACTION) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok:false, error:"reCAPTCHA action mismatch", expected: EXPECT_ACTION, got: vAction }) };
  }
  if (score < MIN_SCORE) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok:false, error:"Low reCAPTCHA score", score, min: MIN_SCORE }) };
  }

  // ✅ Submit to HubSpot Forms API
  const hsUrl = `https://api.hsforms.com/submissions/v3/integration/submit/${encodeURIComponent(portalId)}/${encodeURIComponent(formId)}`;

  const hsPayload = {
    fields: Object.entries(fields).map(([name, value]) => ({ name, value: String(value ?? "") })),
    context: {
      pageUri: String(context.pageUri || ""),
      pageName: String(context.pageName || "")
    }
  };

  const hsRes = await fetch(hsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(hsPayload)
  });

  const hsText = await readText(hsRes);

  if (!hsRes.ok) {
    return { statusCode: 502, headers, body: JSON.stringify({ ok:false, error:"HubSpot submit failed", status: hsRes.status, detail: hsText }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok:true, score, action: vAction || action || null }) };
}
