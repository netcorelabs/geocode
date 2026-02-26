// netlify/functions/ensure-line-item.js
// Creates or updates a single Line Item for a Deal and sets Deal Amount.
// Idempotent: uses hs_sku = lead_id to find/update the line item.

import { randomUUID } from "crypto";

export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "http://www.homesecurecalculator.com",
    "http://homesecurecalculator.com",
    "https://www.netcoreleads.com",
    "https://netcoreleads.com",
    "https://api.netcoreleads.com",
    "https://hubspotgate.netlify.app",
  ];

  function corsHeaders(originRaw) {
    const origin = String(originRaw || "").trim();
    const allowOrigin = origin
      ? (allowedOrigins.includes(origin) ? origin : allowedOrigins[0])
      : "*";
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

  async function readText(res){ try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
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

  async function hsGet(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: hsAuth });
  }

  function parseInvalidProps(errJsonOrText) {
    const invalid = new Set();
    try {
      const j = typeof errJsonOrText === "string" ? JSON.parse(errJsonOrText) : errJsonOrText;
      const errs = j?.errors || [];
      for (const e of errs) {
        const names = e?.context?.propertyName;
        if (Array.isArray(names)) names.forEach((n) => invalid.add(String(n)));
      }
    } catch {
      const s = String(errJsonOrText || "");
      const re = /Property\s+\"([^\"]+)\"\s+does not exist/g;
      let m;
      while ((m = re.exec(s))) invalid.add(m[1]);
    }
    return Array.from(invalid);
  }

  async function patchDealSafe(dealId, properties) {
    const first = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties });
    if (first.ok) return first;

    const invalid = parseInvalidProps(first.json || first.text);
    if (!invalid.length) return first;

    const props2 = { ...properties };
    invalid.forEach((k) => delete props2[k]);
    if (!Object.keys(props2).length) return first;

    return hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: props2 });
  }

  async function findLineItemBySku(leadId) {
    const r = await hsPost("/crm/v3/objects/line_items/search", {
      filterGroups: [{ filters: [{ propertyName: "hs_sku", operator: "EQ", value: String(leadId) }] }],
      properties: ["name", "price", "quantity", "hs_sku"],
      limit: 1,
    });
    if (!r.ok) return { ok: false, error: r.text || r.json };
    const li = r.json?.results?.[0];
    return li?.id ? { ok: true, id: li.id } : { ok: true, id: null };
  }

  async function createLineItemForDeal({ dealId, leadId, name, price }) {
    // HubSpot-defined association type: Line Item -> Deal = 20
    const r = await hsPost("/crm/v3/objects/line_items", {
      properties: {
        name: String(name || "Home Secure Lead"),
        price: String(price ?? "0"),
        quantity: "1",
        hs_sku: String(leadId || randomUUID()),
      },
      associations: [{
        to: { id: String(dealId) },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 20 }],
      }],
    });
    if (!r.ok) return { ok: false, error: r.text || r.json };
    return { ok: true, id: r.json?.id };
  }

  async function updateLineItem(lineItemId, { name, price }) {
    const r = await hsPatch(`/crm/v3/objects/line_items/${encodeURIComponent(lineItemId)}`, {
      properties: {
        name: String(name || "Home Secure Lead"),
        price: String(price ?? "0"),
        quantity: "1",
      },
    });
    if (!r.ok) return { ok: false, error: r.text || r.json };
    return { ok: true };
  }

  function safeNum(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }

  try {
    const body = JSON.parse(event.body || "{}");

    const deal_id = String(body.deal_id || "").trim();
    const lead_id = String(body.lead_id || "").trim();
    const lead_price = safeNum(body.lead_price);
    const currency = String(body.currency || "USD").trim();
    const line_item_name = String(body.line_item_name || "Home Secure Lead").trim();
    const dealname_suggested = String(body.dealname_suggested || "").trim();

    if (!deal_id) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id" }) };
    if (!lead_id) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing lead_id" }) };

    const dealCheck = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(deal_id)}?properties=dealname,amount,description`);
    if (!dealCheck.ok) {
      return { statusCode: 404, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal not found", detail: dealCheck.text, deal_id }) };
    }

    const found = await findLineItemBySku(lead_id);
    if (!found.ok) return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Line item search failed", detail: found.error }) };

    let lineItemId = found.id;
    if (lineItemId) {
      const upd = await updateLineItem(lineItemId, { name: line_item_name, price: lead_price });
      if (!upd.ok) return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Line item update failed", detail: upd.error, line_item_id: lineItemId }) };
    } else {
      const created = await createLineItemForDeal({ dealId: deal_id, leadId: lead_id, name: line_item_name, price: lead_price });
      if (!created.ok || !created.id) return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Line item create failed", detail: created.error }) };
      lineItemId = created.id;
    }

    const existingName = String(dealCheck.json?.properties?.dealname || "").trim();
    const dealProps = { amount: String(Math.round(lead_price)) };

    if (dealname_suggested && (!existingName || existingName.toLowerCase().includes("location"))) {
      dealProps.dealname = dealname_suggested;
    }

    // Store pricing in description block (no custom props required)
    const desc0 = String(dealCheck.json?.properties?.description || "");
    const A = "HSC_LISTING_V1_BEGIN";
    const B = "HSC_LISTING_V1_END";
    const listingBlock = [A, `lead_id,${lead_id}`, `currency,${currency}`, `lead_price,${Math.round(lead_price)}`, `line_item_id,${lineItemId}`, B].join("\n");

    let desc = desc0 || "";
    const re = new RegExp(`${A}[\\s\\S]*?${B}\\n?`, "m");
    if (re.test(desc)) desc = desc.replace(re, "");
    desc = (desc.trim() ? (desc.trim() + "\n\n") : "") + listingBlock + "\n";

    dealProps.description = desc;

    const patched = await patchDealSafe(deal_id, dealProps);
    if (!patched.ok) {
      return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal update failed", detail: patched.text, deal_id }) };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ ok: true, deal_id, lead_id, lead_price: Math.round(lead_price), line_item_id: lineItemId }),
    };
  } catch (err) {
    console.error("ensure-line-item error:", err);
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
  }
}
