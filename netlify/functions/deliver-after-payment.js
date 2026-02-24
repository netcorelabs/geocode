
// netlify/functions/deliver-after-payment.js
export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "https://www.netcoreleads.com",
    "https://netcoreleads.com",
    "https://api.netcoreleads.com",
    "https://hubspotgate.netlify.app",
  ];

  function corsHeaders(originRaw) {
    const origin = (originRaw || "").trim();
    const allowOrigin = origin ? (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]) : "*";
    return {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    };
  }

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Method Not Allowed" }) };

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  async function hsGet(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: hsAuth });
  }
  async function hsPost(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function hsPatch(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "PATCH",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function dealPropertyExists(name) {
    const r = await hsGet(`/crm/v3/properties/deals/${encodeURIComponent(name)}`);
    return r.ok;
  }

  async function readDealById(dealId) {
    const props = [
      "lead_id",
      "deliverable_pdf_file_id",
      "deliverable_csv_file_id",
      "listing_status",
      "dealname",
    ].join(",");
    const r = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${encodeURIComponent(props)}`);
    return r.ok && r.json?.id ? r.json : null;
  }

  async function findDealByLeadId(leadId) {
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id", "deliverable_pdf_file_id", "deliverable_csv_file_id", "listing_status", "dealname"],
      limit: 1,
    });
    return r.ok && r.json?.results?.[0] ? r.json.results[0] : null;
  }

  async function getAssociatedPaymentIds(dealId) {
    // v4 associations: deal -> commerce_payments
    const r = await fetchJson(
      `https://api.hubapi.com/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/commerce_payments?limit=100`,
      { method: "GET", headers: hsAuth }
    );
    if (!r.ok) return { ok: false, ids: [], raw: r };

    const ids = [];
    const results = Array.isArray(r.json?.results) ? r.json.results : [];
    for (const row of results) {
      // HubSpot v4 returns "toObjectId"
      const id = row?.toObjectId || row?.id;
      if (id != null) ids.push(String(id));
    }
    return { ok: true, ids, raw: r };
  }

  async function readPayment(paymentId) {
    // hs_latest_status is the key flag; example shows "succeeded". :contentReference[oaicite:8]{index=8}
    const props = "hs_latest_status,hs_initial_amount,hs_currency_code,hs_initiated_date,hs_createdate";
    const r = await hsGet(`/crm/v3/objects/commerce_payments/${encodeURIComponent(paymentId)}?properties=${encodeURIComponent(props)}`);
    if (!r.ok || !r.json?.id) return null;
    return r.json;
  }

  async function createSignedUrl(fileId) {
    // For PRIVATE files, signed-url is how you view/download. :contentReference[oaicite:9]{index=9}
    const r = await fetchJson(`https://api.hubapi.com/files/v3/files/${encodeURIComponent(fileId)}/signed-url`, {
      method: "GET",
      headers: hsAuth,
    });
    const url = String(r.json?.url || "").trim();
    if (!r.ok || !url) return { ok: false, status: r.status, text: r.text || "Failed to create signed URL" };
    return { ok: true, url };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const deal_id = String(body.deal_id || "").trim();
    const lead_id = String(body.lead_id || "").trim();

    if (!deal_id && !lead_id) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id or lead_id" }) };
    }

    let deal = null;
    if (deal_id) deal = await readDealById(deal_id);
    else deal = await findDealByLeadId(lead_id);

    if (!deal?.id) {
      return { statusCode: 404, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal not found", deal_id, lead_id }) };
    }

    const dealId = String(deal.id);
    const pdfFileId = String(deal.properties?.deliverable_pdf_file_id || "").trim();
    const csvFileId = String(deal.properties?.deliverable_csv_file_id || "").trim();

    if (!pdfFileId || !csvFileId) {
      return {
        statusCode: 409,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "Deliverables not ready",
          deal_id: dealId,
          missing: {
            deliverable_pdf_file_id: !pdfFileId,
            deliverable_csv_file_id: !csvFileId,
          },
        }),
      };
    }

    // Verify payment status from associated commerce payments
    const assoc = await getAssociatedPaymentIds(dealId);
    if (!assoc.ok) {
      return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Failed to read payment associations", detail: assoc.raw?.text }) };
    }

    const payments = [];
    for (const pid of assoc.ids) {
      const p = await readPayment(pid);
      if (p) payments.push(p);
    }

    const paid = payments.some(p => String(p.properties?.hs_latest_status || "").toLowerCase() === "succeeded");

    if (!paid) {
      return {
        statusCode: 402,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          ok: false,
          paid: false,
          deal_id: dealId,
          payment_statuses: payments.map(p => ({
            id: p.id,
            hs_latest_status: p.properties?.hs_latest_status,
            hs_initial_amount: p.properties?.hs_initial_amount,
            hs_currency_code: p.properties?.hs_currency_code,
          })),
        }),
      };
    }

    // Generate signed URLs (short-lived; store only if you want)
    const pdfSigned = await createSignedUrl(pdfFileId);
    const csvSigned = await createSignedUrl(csvFileId);

    if (!pdfSigned.ok || !csvSigned.ok) {
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "Failed to generate signed URLs",
          pdf: pdfSigned,
          csv: csvSigned,
          deal_id: dealId,
        }),
      };
    }

    // Update deal status + optionally store signed URLs
    const listingStatusExists = await dealPropertyExists("listing_status");
    const pdfUrlPropExists = await dealPropertyExists("deliverable_pdf_signed_url");
    const csvUrlPropExists = await dealPropertyExists("deliverable_csv_signed_url");
    const expPropExists = await dealPropertyExists("deliverable_signed_urls_expires_at");

    const props = {};
    if (listingStatusExists) props.listing_status = "Paid";
    if (pdfUrlPropExists) props.deliverable_pdf_signed_url = pdfSigned.url;
    if (csvUrlPropExists) props.deliverable_csv_signed_url = csvSigned.url;

    // Signed urls usually expire; we store an "expires_at" marker you can use in workflows
    if (expPropExists) {
      const expires = new Date(Date.now() + 55 * 60 * 1000).toISOString();
      props.deliverable_signed_urls_expires_at = expires;
    }

    if (Object.keys(props).length) {
      const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: props });
      if (!patched.ok) {
        return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal patch failed", detail: patched.text }) };
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        paid: true,
        deal_id: dealId,
        pdf_url: pdfSigned.url,
        csv_url: csvSigned.url,
        note: "Use a HubSpot workflow to email these links (recommended).",
      }),
    };
  } catch (err) {
    console.error("deliver-after-payment error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
