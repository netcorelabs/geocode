// netlify/functions/ensure-line-item.js
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

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) {
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }),
    };
  }

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  async function patchDealWithFallback(dealId, properties) {
    const attempt = async (props) =>
      fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
        method: "PATCH",
        headers: { ...hsAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: props }),
      });

    let r = await attempt(properties);
    if (r.ok) return r;

    const badProps = new Set(
      (r.json?.errors || [])
        .filter((e) => e.code === "PROPERTY_DOESNT_EXIST")
        .flatMap((e) => e.context?.propertyName || [])
    );

    if (badProps.size) {
      const filtered = Object.fromEntries(Object.entries(properties).filter(([k]) => !badProps.has(k)));
      if (Object.keys(filtered).length) {
        r = await attempt(filtered);
        if (r.ok) return r;
      }
    }
    return r;
  }

  async function getDeal(dealId) {
    return fetchJson(
      `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=dealname,amount,lead_id`,
      { method: "GET", headers: { ...hsAuth } }
    );
  }

  async function listDealLineItems(dealId) {
    return fetchJson(
      `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items?limit=100`,
      { method: "GET", headers: { ...hsAuth } }
    );
  }

  async function createLineItem({ dealId, name, price, currency }) {
    // HubSpot-defined Deal ↔ Line Item associationTypeId = 20
    const associationTypeId = 20;

    const body = {
      properties: {
        name: String(name || "Home Secure Lead"),
        quantity: "1",
        price: String(Number(price || 0)),
        ...(currency ? { hs_currency_code: String(currency) } : {}),
      },
      associations: [
        {
          to: { id: String(dealId) },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId }],
        },
      ],
    };

    return fetchJson("https://api.hubapi.com/crm/v3/objects/line_items", {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function patchLineItem(lineItemId, props) {
    return fetchJson(`https://api.hubapi.com/crm/v3/objects/line_items/${encodeURIComponent(lineItemId)}`, {
      method: "PATCH",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });
  }

  async function ensureDefaultAssociation(lineItemId, dealId) {
    // “default” association doesn’t require type id
    const url =
      `https://api.hubapi.com/crm/v4/objects/line_items/${encodeURIComponent(lineItemId)}` +
      `/associations/default/deals/${encodeURIComponent(dealId)}`;

    return fetchJson(url, { method: "PUT", headers: { ...hsAuth } });
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const deal_id = String(body.deal_id || "").trim();
    const lead_id = String(body.lead_id || "").trim();
    const lead_price = Number(body.lead_price || 0);
    const currency = String(body.currency || "USD").trim();
    const line_item_name = String(body.line_item_name || "").trim() || "Home Secure Lead";
    const dealname_suggested = String(body.dealname_suggested || "").trim();

    if (!deal_id) {
      return {
        statusCode: 400,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Missing deal_id" }),
      };
    }
    if (!Number.isFinite(lead_price) || lead_price <= 0) {
      return {
        statusCode: 400,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Missing/invalid lead_price" }),
      };
    }

    // Find existing line item linked to deal
    const assoc = await listDealLineItems(deal_id);
    let lineItemId = assoc.ok ? String(assoc.json?.results?.[0]?.id || "").trim() : "";

    if (!lineItemId) {
      const created = await createLineItem({ dealId: deal_id, name: line_item_name, price: lead_price, currency });
      if (!created.ok || !created.json?.id) {
        return {
          statusCode: 500,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({
            error: "ensure-line-item failed",
            detail: `Create line item failed (${created.status}): ${created.text || JSON.stringify(created.json)}`,
          }),
        };
      }
      lineItemId = String(created.json.id).trim();
    } else {
      // Update existing LI values
      const upd = await patchLineItem(lineItemId, {
        name: line_item_name,
        quantity: "1",
        price: String(lead_price),
        ...(currency ? { hs_currency_code: String(currency) } : {}),
      });
      if (!upd.ok) {
        // keep going; association might still be fine
      }
    }

    // Ensure the default association exists (safe/idempotent)
    await ensureDefaultAssociation(lineItemId, deal_id);

    // Patch deal amount + optional name patch if it contains "Location"
    const deal = await getDeal(deal_id);
    const curName = String(deal.json?.properties?.dealname || "");
    const nameContainsLocation = /location/i.test(curName);

    const dealPatchProps = {
      amount: String(lead_price),
      ...(lead_id ? { lead_id: lead_id } : {}),
    };

    if (dealname_suggested && nameContainsLocation) {
      dealPatchProps.dealname = dealname_suggested;
    }

    const dealPatch = await patchDealWithFallback(deal_id, dealPatchProps);

    if (!dealPatch.ok) {
      return {
        statusCode: 200,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          ok: true,
          warning: "Line item created/updated, but deal patch had warnings.",
          deal_patch_error: dealPatch.text || dealPatch.json || null,
          deal_id,
          line_item_id: lineItemId,
          lead_price,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        deal_id,
        line_item_id: lineItemId,
        lead_price,
        currency,
      }),
    };
  } catch (err) {
    console.error("ensure-line-item error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "ensure-line-item failed", detail: String(err?.message || err) }),
    };
  }
}
