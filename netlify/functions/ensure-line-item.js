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

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  async function patchWithFallback(objectType, objectId, properties) {
    const attempt = async (props) =>
      fetchJson(`https://api.hubapi.com/crm/v3/objects/${objectType}/${encodeURIComponent(objectId)}`, {
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

  async function findContactIdByEmail(email) {
    const e = String(email || "").trim().toLowerCase();
    if (!e) return "";
    const r = await fetchJson("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: e }] }],
        properties: ["email"],
        limit: 1,
      }),
    });
    return r.ok && r.json?.results?.[0]?.id ? String(r.json.results[0].id) : "";
  }

  function zip3xx(zip) {
    const m = String(zip || "").match(/\b(\d{3})\d{2}\b/);
    return m ? `${m[1]}xx` : "";
  }

  function redactedLoc({ city, state, zip }) {
    const c = String(city || "").trim();
    const s = String(state || "").trim();
    const z = zip3xx(zip);
    const base = [c, s].filter(Boolean).join(", ");
    return (base + (z ? ` ${z}` : "")).trim();
  }

  async function getAssocTypeIdDealsLineItems() {
    try {
      const r = await fetchJson(
        "https://api.hubapi.com/crm/v4/associations/deals/line_items/labels",
        { method: "GET", headers: { ...hsAuth } }
      );
      const results = r.json?.results || [];
      if (results.length) {
        const pick = results.find(x => x.associationCategory === "HUBSPOT_DEFINED") || results[0];
        if (pick?.associationTypeId) return pick.associationTypeId;
      }
      // fallback default ID (works for most portals)
      return 29;
    } catch {
      return 29;
    }
  }

  async function listDealLineItems(dealId) {
    const r = await fetchJson(
      `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items?limit=10`,
      { method: "GET", headers: { ...hsAuth } }
    );
    const ids = (r.json?.results || []).map(x => String(x.id));
    return { ok: r.ok, ids, raw: r };
  }

  async function createLineItem({ name, price, currency }) {
    const props = { name: String(name || "Home Secure Lead"), price: String(Number(price || 0)), quantity: "1", hs_currency: String(currency || "USD") };
    const r = await fetchJson("https://api.hubapi.com/crm/v3/objects/line_items", {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });
    if (!r.ok || !r.json?.id) throw new Error(`Create line item failed (${r.status}): ${r.text || JSON.stringify(r.json)}`);
    return String(r.json.id);
  }

  async function updateLineItem(lineItemId, { name, price, currency }) {
    const props = { name: String(name || "Home Secure Lead"), price: String(Number(price || 0)), quantity: "1", hs_currency: String(currency || "USD") };
    const r = await patchWithFallback("line_items", lineItemId, props);
    if (!r.ok) throw new Error(`Update line item failed (${r.status}): ${r.text || JSON.stringify(r.json)}`);
    return true;
  }

  async function associateDealToLineItem(dealId, lineItemId, associationTypeId) {
    const url =
      `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items/${encodeURIComponent(lineItemId)}/${encodeURIComponent(String(associationTypeId))}`;
    const r = await fetchJson(url, { method: "PUT", headers: { ...hsAuth } });
    if (!r.ok) throw new Error(`Associate deal→line_item failed (${r.status}): ${r.text || JSON.stringify(r.json)}`);
    return true;
  }

  async function readDeal(dealId) {
    const r = await fetchJson(
      `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=dealname,amount,lead_id,hs_object_id`,
      { method: "GET", headers: { ...hsAuth } }
    );
    if (!r.ok) return null;
    return r.json;
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const deal_id = String(body.deal_id || "").trim();
    const lead_id = String(body.lead_id || "").trim();
    const email   = String(body.email || "").trim();
    const city    = String(body.city || "").trim();
    const state   = String(body.state || body.state_code || "").trim();
    const zip     = String(body.zip || body.postal_code || "").trim();

    const lead_price = Number(body.lead_price || 0);
    const currency   = String(body.currency || "USD").trim() || "USD";
    const line_item_name = String(body.line_item_name || "").trim();

    if (!deal_id || !lead_id) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id or lead_id" }) };
    }
    if (!Number.isFinite(lead_price) || lead_price <= 0) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing/invalid lead_price" }) };
    }

    const contactId = await findContactIdByEmail(email);
    const loc = redactedLoc({ city, state, zip }) || "Lead";
    const dealnameDesired = `Home Secure Lead — ${loc} — C${contactId || "NA"}`;

    const assocTypeId = await getAssocTypeIdDealsLineItems();
    const liList = await listDealLineItems(deal_id);
    let lineItemId = liList.ids?.[0] || "";

    if (!lineItemId) {
      lineItemId = await createLineItem({ name: line_item_name || dealnameDesired, price: lead_price, currency });
      await associateDealToLineItem(deal_id, lineItemId, assocTypeId);
    } else {
      await updateLineItem(lineItemId, { name: line_item_name || dealnameDesired, price: lead_price, currency });
    }

    const deal = await readDeal(deal_id);
    const currentName = String(deal?.properties?.dealname || "");
    const shouldPatchName = !currentName || /location/i.test(currentName) || (contactId && !currentName.includes(`C${contactId}`));

    const dealProps = {
      amount: String(Math.round(lead_price)),
      lead_price: String(Math.round(lead_price)),
      lead_status: "Deliverables Processing",
    };
    if (shouldPatchName) dealProps.dealname = dealnameDesired;

    await patchWithFallback("deals", deal_id, dealProps);

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        deal_id,
        lead_id,
        contact_id: contactId || null,
        associationTypeId: assocTypeId,
        line_item_id: lineItemId,
        dealname: shouldPatchName ? dealnameDesired : currentName,
        amount: Math.round(lead_price),
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
