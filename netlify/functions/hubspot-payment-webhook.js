// netlify/functions/hubspot-payment-webhook.js
import crypto from "node:crypto";

export async function handler(event) {
  const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";
  const HS_CLIENT_SECRET = process.env.HUBSPOT_APP_CLIENT_SECRET || "";
  const API_BASE = (process.env.LEAD_STORE_API_URL || "https://api.netcoreleads.com").replace(/\/$/, "");

  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
  const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "";

  if (!HS_TOKEN) return { statusCode: 500, body: "Missing HUBSPOT_PRIVATE_APP_TOKEN" };

  // --- Helpers ---
  async function readText(res) {
    try { return await res.text(); } catch { return ""; }
  }

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  // --- HubSpot signature validation (supports v1 + v3) ---
  // v1: sha256(clientSecret + body).hexdigest() :contentReference[oaicite:8]{index=8}
  // v3: base64(HMAC_SHA256(clientSecret, method+uri+body+timestamp)) :contentReference[oaicite:9]{index=9}
  function timingSafeEqual(a, b) {
    const ba = Buffer.from(a || "", "utf8");
    const bb = Buffer.from(b || "", "utf8");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  }

  function computeV1Signature(clientSecret, rawBody) {
    return crypto.createHash("sha256").update(`${clientSecret}${rawBody}`, "utf8").digest("hex");
  }

  function computeV3Signature(clientSecret, method, uri, rawBody, timestamp) {
    const source = `${method}${uri}${rawBody}${timestamp}`;
    const hmac = crypto.createHmac("sha256", clientSecret).update(source, "utf8").digest();
    return hmac.toString("base64");
  }

  function validateHubSpotSignature() {
    if (!HS_CLIENT_SECRET) {
      // If you don't set it, we can't verify authenticity
      return false;
    }

    const rawBody = event.body || "";
    const method = (event.httpMethod || "POST").toUpperCase();

    // Netlify gives host + path; webhooks should have no query params
    const host = event.headers?.host || event.headers?.Host || "";
    const path = event.path || "/.netlify/functions/hubspot-payment-webhook";
    const uri = `https://${host}${path}`;

    const sigV3 = event.headers?.["x-hubspot-signature-v3"] || event.headers?.["X-HubSpot-Signature-V3"];
    const ts = event.headers?.["x-hubspot-request-timestamp"] || event.headers?.["X-HubSpot-Request-Timestamp"];

    if (sigV3 && ts) {
      const expected = computeV3Signature(HS_CLIENT_SECRET, method, uri, rawBody, ts);
      return timingSafeEqual(expected, sigV3);
    }

    const sig = event.headers?.["x-hubspot-signature"] || event.headers?.["X-HubSpot-Signature"];
    const ver = (event.headers?.["x-hubspot-signature-version"] || event.headers?.["X-HubSpot-Signature-Version"] || "v1").toLowerCase();

    if (!sig) return false;

    if (ver === "v1") {
      const expected = computeV1Signature(HS_CLIENT_SECRET, rawBody);
      return timingSafeEqual(expected, sig);
    }

    // If HubSpot sends v2 here, you can add v2 logic later; v1/v3 covers most webhook cases.
    return false;
  }

  if (!validateHubSpotSignature()) {
    // HubSpot recommends validating signature headers :contentReference[oaicite:10]{index=10}
    return { statusCode: 401, body: "Invalid HubSpot signature" };
  }

  // --- Parse webhook payload ---
  let payload;
  try { payload = JSON.parse(event.body || "[]"); } catch { payload = []; }
  const events = Array.isArray(payload) ? payload : (payload?.events || []);

  // HubSpot API auth
  const hsAuthHeaders = { Authorization: `Bearer ${HS_TOKEN}` };

  async function getPayment(paymentId) {
    // Commerce payments object: /crm/v3/objects/commerce_payments/{id} :contentReference[oaicite:11]{index=11}
    const props = ["hs_latest_status", "hs_customer_email", "hs_initial_amount", "hs_currency_code"].join(",");
    return fetchJson(`https://api.hubapi.com/crm/v3/objects/commerce_payments/${paymentId}?properties=${encodeURIComponent(props)}`, {
      headers: hsAuthHeaders,
    });
  }

  async function getAssociatedDealsForPayment(paymentId) {
    // Standard associations read endpoint works for CRM objects, including commerce payments (generic webhooks supports it) :contentReference[oaicite:12]{index=12}
    const r = await fetchJson(`https://api.hubapi.com/crm/v3/objects/commerce_payments/${paymentId}/associations/deals`, {
      headers: hsAuthHeaders,
    });
    const ids = (r.json?.results || []).map(x => x.id).filter(Boolean);
    return ids;
  }

  async function getDeal(dealId) {
    const props = [
      "listing_status",
      "delivery_token",
      "delivery_expires_at",
      "deliverable_pdf_file_id",
      "deliverable_csv_file_id",
      "buy_now_url",
      "lead_id",
    ].join(",");
    return fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=${encodeURIComponent(props)}`, {
      headers: hsAuthHeaders,
    });
  }

  async function patchDeal(dealId, properties) {
    return fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
      method: "PATCH",
      headers: { ...hsAuthHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ properties }),
    });
  }

  async function sendEmail(toEmail, subject, text) {
    if (!SENDGRID_API_KEY || !SENDGRID_FROM_EMAIL || !toEmail) return { ok: false, reason: "SendGrid not configured" };
    return fetchJson("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: toEmail }] }],
        from: { email: SENDGRID_FROM_EMAIL },
        subject,
        content: [{ type: "text/plain", value: text }],
      }),
    });
  }

  // --- Process events ---
  const processed = [];

  for (const e of events) {
    const paymentId = String(e?.objectId || "").trim();
    if (!paymentId) continue;

    const payRes = await getPayment(paymentId);
    if (!payRes.ok) continue;

    const p = payRes.json?.properties || {};
    const status = String(p.hs_latest_status || "");
    const buyerEmail = String(p.hs_customer_email || "");

    // We only deliver on succeeded :contentReference[oaicite:13]{index=13}
    if (status !== "succeeded") continue;

    const dealIds = await getAssociatedDealsForPayment(paymentId);
    if (!dealIds.length) {
      processed.push({ paymentId, status, buyerEmail, note: "No associated deal found (ensure payment link was created from the deal)." });
      continue;
    }

    for (const dealId of dealIds) {
      const dealRes = await getDeal(dealId);
      if (!dealRes.ok) continue;

      const d = dealRes.json?.properties || {};
      const listingStatus = String(d.listing_status || "");

      // Idempotent: if already Sold/Delivered, skip
      if (listingStatus === "Sold" || listingStatus === "Delivered") {
        processed.push({ paymentId, dealId, status, listingStatus, skipped: true });
        continue;
      }

      // Stamp delivery token + expiry (24h)
      const token = crypto.randomUUID();
      const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

      await patchDeal(dealId, {
        listing_status: "Sold",
        delivery_token: token,
        delivery_expires_at: String(expiresAt),
      });

      const deliverablesUrl = `${API_BASE}/.netlify/functions/deliverables?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(token)}`;
      const pdfUrl = `${API_BASE}/.netlify/functions/download-pdf?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(token)}`;
      const csvUrl = `${API_BASE}/.netlify/functions/download-csv?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(token)}`;

      const emailText =
        `Thanks for your purchase.\n\n` +
        `Lead deliverables (expires in 24 hours):\n` +
        `PDF: ${pdfUrl}\n` +
        `CSV: ${csvUrl}\n` +
        `All-in-one page: ${deliverablesUrl}\n`;

      const emailRes = await sendEmail(
        buyerEmail,
        "Your purchased lead deliverables",
        emailText
      );

      processed.push({
        paymentId,
        dealId,
        buyerEmail,
        delivered: true,
        emailed: Boolean(emailRes?.ok),
      });
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, processedCount: processed.length, processed }),
  };
}
