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

  async function patchDealWithFallback(dealId, properties) {
    const attempt = async (props) =>
      hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: props });

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

  async function listDealLineItems(dealId) {
    // CRM v4 list associations
    const r = await hsGet(`/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/line_items?limit=100`);
    if (!r.ok) return [];
    const results = r.json?.results || [];
    // results items typically: { toObjectId, associationTypes:[...] }
    return results.map(x => String(x.toObjectId || x.id || "")).filter(Boolean);
  }

  async function associateLineItemToDealDefault(lineItemId, dealId) {
    // Preferred: default association endpoint (no associationTypeId needed)
    const r = await fetchJson(
      `https://api.hubapi.com/crm/v4/objects/line_items/${encodeURIComponent(lineItemId)}` +
      `/associations/default/deals/${encodeURIComponent(dealId)}`,
      { method: "PUT", headers: { ...hsAuth } }
    );
    if (r.ok) return { ok: true };
    return { ok: false, status: r.status, text: r.text || JSON.stringify(r.json) };
  }

  async function associateLineItemToDealTypeId(lineItemId, dealId) {
    // Fallback: explicit associationTypeId (Line item -> Deal = 20) :contentReference[oaicite:2]{index=2}
    const associationTypeId = 20;
    const r = await fetchJson(
      `https://api.hubapi.com/crm/v3/objects/line_items/${encodeURIComponent(lineItemId)}` +
      `/associations/deals/${encodeURIComponent(dealId)}/${associationTypeId}`,
      { method: "PUT", headers: { ...hsAuth } }
    );
    if (r.ok) return { ok: true };
    return { ok: false, status: r.status, text: r.text || JSON.stringify(r.json) };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const deal_id = String(body.deal_id || "").trim();
    const lead_id = String(body.lead_id || "").trim();
    const lead_price_num = Number(body.lead_price || 0);
    const lead_price = Number.isFinite(lead_price_num) ? Math.round(lead_price_num) : 0;

    const line_item_name = String(body.line_item_name || "").trim() || `Home Secure Lead — ${lead_id || "Lead"}`;
    const dealname_suggested = String(body.dealname_suggested || "").trim();

    if (!deal_id || !lead_id || !lead_price) {
      return {
        statusCode: 400,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Missing deal_id, lead_id, or lead_price" }),
      };
    }

    // Read deal name so we only patch if needed
    const dealRead = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(deal_id)}?properties=dealname,amount`);
    const currentDealName = String(dealRead.json?.properties?.dealname || "").trim();

    // 1) Find existing associated line item (idempotent)
    const existing = await listDealLineItems(deal_id);
    let lineItemId = existing[0] || "";

    // 2) Create or patch line item
    if (!lineItemId) {
      const created = await hsPost("/crm/v3/objects/line_items", {
        properties: {
          name: line_item_name,
          price: String(lead_price),
          quantity: "1",
          // optional helper (exists in many portals; if not, HubSpot ignores on create? if it errors, you'll see it)
          hs_sku: lead_id,
        },
      });

      if (!created.ok || !created.json?.id) {
        return {
          statusCode: 500,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({
            error: "ensure-line-item failed",
            detail: created.text || JSON.stringify(created.json),
          }),
        };
      }

      lineItemId = String(created.json.id);

      // Associate to deal
      let assoc = await associateLineItemToDealDefault(lineItemId, deal_id);
      if (!assoc.ok) {
        assoc = await associateLineItemToDealTypeId(lineItemId, deal_id);
        if (!assoc.ok) {
          return {
            statusCode: 500,
            headers: corsHeaders(event.headers?.origin),
            body: JSON.stringify({
              error: "ensure-line-item failed",
              detail: `Could not associate line item to deal: ${assoc.status} ${assoc.text}`,
              line_item_id: lineItemId,
              deal_id,
            }),
          };
        }
      }
    } else {
      // Patch existing line item to match price/name
      const patched = await hsPatch(`/crm/v3/objects/line_items/${encodeURIComponent(lineItemId)}`, {
        properties: {
          name: line_item_name,
          price: String(lead_price),
          quantity: "1",
        },
      });

      if (!patched.ok) {
        return {
          statusCode: 500,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({
            error: "ensure-line-item failed",
            detail: patched.text || JSON.stringify(patched.json),
            line_item_id: lineItemId,
            deal_id,
          }),
        };
      }
    }

    // 3) Patch deal amount (+ optionally dealname)
    const patchProps = { amount: String(lead_price) };

    if (dealname_suggested) {
      const shouldPatchName =
        !currentDealName ||
        currentDealName.toLowerCase().includes("location") ||
        currentDealName.toLowerCase().includes("lead — location");

      if (shouldPatchName) patchProps.dealname = dealname_suggested;
    }

    const dealPatched = await patchDealWithFallback(deal_id, patchProps);

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        deal_id,
        line_item_id: lineItemId,
        lead_id,
        lead_price,
        deal_patch_ok: !!dealPatched.ok,
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
