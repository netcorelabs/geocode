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
    return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
  }

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

  async function readText(res){ try { return await res.text(); } catch { return ""; } }
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

  async function getAssocTypeIdLineItemToDeal() {
    const res = await fetchJson("https://api.hubapi.com/crm/v4/associations/line_items/deals/labels", {
      method: "GET",
      headers: { ...hsAuth },
    });
    if (!res.ok) throw new Error(`Assoc labels lookup failed (${res.status}): ${res.text}`);

    const results = res.json?.results || [];
    const pick =
      results.find((x) => x.associationCategory === "HUBSPOT_DEFINED") ||
      results.find((x) => x.associationTypeId) ||
      results[0];

    const typeId = pick?.associationTypeId;
    if (!typeId) throw new Error("Could not determine line_item→deal associationTypeId");
    return Number(typeId);
  }

  async function listDealLineItems(dealId) {
    const res = await fetchJson(
      `https://api.hubapi.com/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/line_items`,
      { method: "GET", headers: { ...hsAuth } }
    );
    if (!res.ok) return [];
    const out = res.json?.results || [];
    return out.map((x) => String(x.toObjectId || "")).filter(Boolean);
  }

  async function createLineItem(props) {
    const res = await fetchJson("https://api.hubapi.com/crm/v3/objects/line_items", {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });
    if (!res.ok) throw new Error(`Create line item failed (${res.status}): ${res.text}`);
    const id = String(res.json?.id || "").trim();
    if (!id) throw new Error("Create line item missing id");
    return id;
  }

  async function patchLineItem(lineItemId, props) {
    const res = await fetchJson(`https://api.hubapi.com/crm/v3/objects/line_items/${encodeURIComponent(lineItemId)}`, {
      method: "PATCH",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });
    if (!res.ok) throw new Error(`Patch line item failed (${res.status}): ${res.text}`);
    return true;
  }

  async function associateLineItemToDeal(lineItemId, dealId, associationTypeId) {
    const url =
      `https://api.hubapi.com/crm/v4/objects/line_items/${encodeURIComponent(lineItemId)}` +
      `/associations/deals/${encodeURIComponent(dealId)}/${encodeURIComponent(String(associationTypeId))}`;

    const res = await fetchJson(url, { method: "PUT", headers: { ...hsAuth } });
    if (!res.ok) throw new Error(`Associate line item→deal failed (${res.status}): ${res.text}`);
    return true;
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const deal_id = String(body.deal_id || "").trim();
    const lead_id = String(body.lead_id || "").trim();
    const lead_price = Number(body.lead_price || 0);
    const line_item_name = String(body.line_item_name || "").trim() || "Home Secure Lead";
    const dealname_suggested = String(body.dealname_suggested || "").trim();

    if (!deal_id || !lead_price || lead_price <= 0) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id or lead_price" }) };
    }

    // Read dealname
    const dealGet = await fetchJson(
      `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(deal_id)}?properties=dealname`,
      { method: "GET", headers: { ...hsAuth } }
    );

    const currentName = String(dealGet.json?.properties?.dealname || "");
    const shouldRename = !!dealname_suggested && currentName.toLowerCase().includes("location");

    // Patch deal amount + optional lead props
    await patchDealWithFallback(deal_id, {
      amount: String(Math.round(lead_price)),       // standard deal amount
      lead_price: String(Math.round(lead_price)),   // custom (if exists)
      lead_id: lead_id || undefined,                // custom (if exists)
      ...(shouldRename ? { dealname: dealname_suggested } : {}),
    });

    // Ensure line item exists
    const assocTypeId = await getAssocTypeIdLineItemToDeal();
    const existing = await listDealLineItems(deal_id);

    let lineItemId = existing[0] || "";

    if (!lineItemId) {
      lineItemId = await createLineItem({
        name: line_item_name,
        quantity: "1",
        price: String(Math.round(lead_price)),
      });
      await associateLineItemToDeal(lineItemId, deal_id, assocTypeId);
    } else {
      await patchLineItem(lineItemId, {
        name: line_item_name,
        quantity: "1",
        price: String(Math.round(lead_price)),
      });
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        deal_id,
        lead_id: lead_id || null,
        lead_price: Math.round(lead_price),
        line_item_id: lineItemId,
        associationTypeId: assocTypeId,
        renamed: shouldRename,
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
