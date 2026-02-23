// netlify/functions/hubspot-payment-webhook.js
import crypto from "node:crypto";

export async function handler(event) {
  // HubSpot expects 2xx quickly; we still do idempotent processing.
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";
  const HS_CLIENT_SECRET = process.env.HUBSPOT_APP_CLIENT_SECRET || ""; // required for signature validation
  const SOLD_STAGE = process.env.HUBSPOT_DEAL_STAGE_PAID || ""; // optional
  const API_BASE = (process.env.LEAD_STORE_API_URL || "https://api.netcoreleads.com").replace(/\/$/, "");

  // Optional email sending (no Zapier)
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
  const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "";

  if (!HS_TOKEN) return { statusCode: 500, body: "Missing HUBSPOT_PRIVATE_APP_TOKEN" };
  if (!HS_CLIENT_SECRET) return { statusCode: 500, body: "Missing HUBSPOT_APP_CLIENT_SECRET" };

  // ---------------------------
  // Header helpers
  // ---------------------------
  function getHeader(name) {
    const h = event.headers || {};
    const lower = name.toLowerCase();
    for (const k of Object.keys(h)) {
      if (String(k).toLowerCase() === lower) return h[k];
    }
    return "";
  }

  function timingSafeEqual(a, b) {
    const ba = Buffer.from(String(a || ""), "utf8");
    const bb = Buffer.from(String(b || ""), "utf8");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  }

  // HubSpot v3 signature validation:
  // expected = base64(HMAC_SHA256(clientSecret, method + uri + body + timestamp))
  // reject if timestamp older than 5 minutes.
  function decodeHubSpotUri(uri) {
    // HubSpot docs: decode specific URL-encoded chars; we apply a safe mapping.
    const map = [
      ["%3A", ":"], ["%2F", "/"], ["%3F", "?"], ["%40", "@"], ["%21", "!"], ["%24", "$"],
      ["%27", "'"], ["%28", "("], ["%29", ")"], ["%2A", "*"], ["%2C", ","], ["%3B", ";"],
    ];
    let out = String(uri || "");
    for (const [enc, dec] of map) {
      out = out.replace(new RegExp(enc, "gi"), dec);
    }
    return out;
  }

  function computeV3Signature(clientSecret, method, uri, rawBody, timestamp) {
    const source = `${method}${uri}${rawBody}${timestamp}`;
    const hmac = crypto.createHmac("sha256", clientSecret).update(source, "utf8").digest();
    return hmac.toString("base64");
  }

  function validateHubSpotSignatureV3() {
    const sig = getHeader("X-HubSpot-Signature-V3");
    const ts = getHeader("X-HubSpot-Request-Timestamp");

    if (!sig || !ts) return false;

    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return false;

    // reject if older than 5 minutes
    const ageMs = Math.abs(Date.now() - tsNum);
    if (ageMs > 5 * 60 * 1000) return false;

    const method = String(event.httpMethod || "POST").toUpperCase();
    const host = getHeader("host");
    const proto = getHeader("x-forwarded-proto") || "https";
    const path = event.path || "/.netlify/functions/hubspot-payment-webhook";

    // IMPORTANT: HubSpot signs the exact target URL you configured (protocol + host + path).
    const uri = decodeHubSpotUri(`${proto}://${host}${path}`);

    const rawBody = event.body || "";
    const expected = computeV3Signature(HS_CLIENT_SECRET, method, uri, rawBody, ts);

    return timingSafeEqual(expected, sig);
  }

  if (!validateHubSpotSignatureV3()) {
    return { statusCode: 401, body: "Invalid HubSpot signature" };
  }

  // ---------------------------
  // HTTP helpers
  // ---------------------------
  async function readText(res) { try { return await res.text(); } catch { return ""; } }

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  // ---------------------------
  // Deal-only delivery issue logic
  // ---------------------------
  async function issueDeliveryForDeal(dealId) {
    const props = [
      "listing_status",
      "delivery_token",
      "delivery_expires_at",
      "deliverable_pdf_file_id",
      "deliverable_csv_file_id",
    ].join(",");

    const dealRes = await fetchJson(
      `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${encodeURIComponent(props)}`,
      { headers: hsAuth }
    );
    if (!dealRes.ok) return { ok: false, error: `Deal fetch failed: ${dealRes.status}` };

    const p = dealRes.json?.properties || {};
    const listingStatus = String(p.listing_status || "");
    const existingToken = String(p.delivery_token || "");
    const existingExp = Number(p.delivery_expires_at || "0");

    const pdfFileId = String(p.deliverable_pdf_file_id || "").trim();
    const csvFileId = String(p.deliverable_csv_file_id || "").trim();

    // Must exist before sale is finalized
    if (!pdfFileId || !csvFileId) {
      return { ok: false, error: "Deliverables not ready" };
    }

    // Idempotent: if already sold + token valid, reuse
    if ((listingStatus === "Sold" || listingStatus === "Delivered") && existingToken && (!existingExp || Date.now() < existingExp)) {
      return {
        ok: true,
        deal_id: dealId,
        delivery_token: existingToken,
        delivery_expires_at: existingExp || null,
        deliverables_url: `${API_BASE}/.netlify/functions/deliverables?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(existingToken)}`,
        pdf_download_url: `${API_BASE}/.netlify/functions/download-pdf?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(existingToken)}`,
        csv_download_url: `${API_BASE}/.netlify/functions/download-csv?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(existingToken)}`,
        reused: true,
      };
    }

    // If already sold but no token, manual review (avoid double-issuing)
    if (listingStatus === "Sold" || listingStatus === "Delivered") {
      return { ok: false, error: "Already sold (no token). Manual review." };
    }

    const token = crypto.randomUUID();
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

    const patch = {
      properties: {
        listing_status: "Sold",
        delivery_token: token,
        delivery_expires_at: String(expiresAt),
        ...(SOLD_STAGE ? { dealstage: SOLD_STAGE } : {}),
      },
    };

    const upd = await fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      method: "PATCH",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });

    if (!upd.ok) return { ok: false, error: upd.text || "Failed to update deal" };

    return {
      ok: true,
      deal_id: dealId,
      delivery_token: token,
      delivery_expires_at: expiresAt,
      deliverables_url: `${API_BASE}/.netlify/functions/deliverables?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(token)}`,
      pdf_download_url: `${API_BASE}/.netlify/functions/download-pdf?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(token)}`,
      csv_download_url: `${API_BASE}/.netlify/functions/download-csv?deal_id=${encodeURIComponent(dealId)}&token=${encodeURIComponent(token)}`,
      reused: false,
    };
  }

  // ---------------------------
  // Optional SendGrid email
  // ---------------------------
  async function sendEmail(toEmail, subject, text) {
    if (!SENDGRID_API_KEY || !SENDGRID_FROM_EMAIL || !toEmail) {
      return { ok: false, skipped: true };
    }
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

  // ---------------------------
  // Parse webhook payload
  // ---------------------------
  let payload;
  try { payload = JSON.parse(event.body || "[]"); } catch { payload = []; }

  // HubSpot webhook payloads are typically arrays of events
  const events = Array.isArray(payload) ? payload : (payload?.events || []);
  const processed = [];

  // Process each event
  for (const e of events) {
    const objectId = String(e?.objectId || e?.object_id || "").trim();
    const objType = String(e?.subscriptionType || e?.objectType || "").toLowerCase();

    // Generic webhooks should send commerce_payments events; we still guard.
    if (!objectId) continue;

    // Fetch payment to confirm succeeded
    const payProps = ["hs_latest_status", "hs_customer_email", "hs_initial_amount", "hs_currency_code"].join(",");
    const payRes = await fetchJson(
      `https://api.hubapi.com/crm/v3/objects/commerce_payments/${encodeURIComponent(objectId)}?properties=${encodeURIComponent(payProps)}`,
      { headers: hsAuth }
    );

    if (!payRes.ok) {
      processed.push({ payment_id: objectId, ok: false, error: "Payment fetch failed" });
      continue;
    }

    const pay = payRes.json?.properties || {};
    const status = String(pay.hs_latest_status || "");
    const buyerEmail = String(pay.hs_customer_email || "");

    // Only act when succeeded :contentReference[oaicite:2]{index=2}
    if (status !== "succeeded") {
      processed.push({ payment_id: objectId, ok: true, skipped: true, reason: `status=${status}` });
      continue;
    }

    // Find associated deal(s)
    const assocRes = await fetchJson(
      `https://api.hubapi.com/crm/v3/objects/commerce_payments/${encodeURIComponent(objectId)}/associations/deals`,
      { headers: hsAuth }
    );

    const dealIds = (assocRes.json?.results || []).map(x => String(x.id)).filter(Boolean);
    if (!dealIds.length) {
      processed.push({
        payment_id: objectId,
        ok: false,
        error: "No associated deal found. Create the payment link from the Deal so the payment associates to it.",
      });
      continue;
    }

    for (const dealId of dealIds) {
      const issued = await issueDeliveryForDeal(dealId);

      if (!issued.ok) {
        processed.push({ payment_id: objectId, deal_id: dealId, ok: false, error: issued.error });
        continue;
      }

      // Email vendor/buyer the links (optional but recommended)
      const emailText =
        `Thanks for your purchase.\n\n` +
        `Your lead deliverables (expires in 24 hours):\n` +
        `PDF: ${issued.pdf_download_url}\n` +
        `CSV: ${issued.csv_download_url}\n` +
        `All-in-one: ${issued.deliverables_url}\n`;

      const emailRes = await sendEmail(buyerEmail, "Your NetCore Leads delivery links", emailText);

      processed.push({
        payment_id: objectId,
        deal_id: dealId,
        ok: true,
        sold: true,
        reused: Boolean(issued.reused),
        buyer_email: buyerEmail || null,
        emailed: Boolean(emailRes?.ok),
        email_skipped: Boolean(emailRes?.skipped),
        links: {
          pdf: issued.pdf_download_url,
          csv: issued.csv_download_url,
          all: issued.deliverables_url,
        },
      });
    }
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, processed }),
  };
}
