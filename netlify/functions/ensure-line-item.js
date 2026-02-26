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
    return { ok: res.ok, status: res.status, json, text, url };
  }

  function safeNum(v, d = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
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

  async function getDealName(dealId) {
    const r = await fetchJson(
      `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=dealname`,
      { method: "GET", headers: { ...hsAuth } }
    );
    return String(r.json?.properties?.dealname || "").trim();
  }

  async function maybePatchDealName(dealId, suggested) {
    if (!suggested) return { ok: true, skipped: true };
    const current = await getDealName(dealId);
    const curLower = current.toLowerCase();

    // Only patch if it looks like your placeholder (contains "location") or blank
    if (!current || curLower.includes("location")) {
      return patchWithFallback("deals", dealId, { dealname: suggested });
    }
    return { ok: true, skipped: true };
  }

  // ---------- Products (each lead as unique product via hs_sku = lead_id) ----------
  async function findProductBySku(sku) {
    const r = await fetchJson("https://api.hubapi.com/crm/v3/objects/products/search", {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "hs_sku", operator: "EQ", value: sku }] }],
        properties: ["hs_sku", "name", "price"],
        limit: 1,
      }),
    });
    return r.ok && r.json?.results?.[0] ? r.json.results[0] : null;
  }

  async function createProduct({ sku, name, price }) {
    const r = await fetchJson("https://api.hubapi.com/crm/v3/objects/products", {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: {
          hs_sku: sku,
          name: name,
          price: String(price),
          description: `Exclusive lead product (Lead ID: ${sku}).`,
        },
      }),
    });
    if (!r.ok) throw new Error(`Create product failed (${r.status}): ${r.text || JSON.stringify(r.json)}`);
    return r.json;
  }

  // ---------- Line Items ----------
  async function getDealLineItems(dealId) {
    // v3 association list
    const r = await fetchJson(
      `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items?limit=100`,
      { method: "GET", headers: { ...hsAuth } }
    );
    const results = r.json?.results || [];
    // results are usually [{id:"..."}]
    const ids = results.map((x) => String(x.id || x.toObjectId || x).trim()).filter(Boolean);
    return { ok: r.ok, status: r.status, ids, raw: r.json, text: r.text };
  }

  async function createLineItem({ name, productId, price, quantity }) {
    // Create with a minimal set and fallback if any prop invalid
    const props = {
      name: String(name || "Home Secure Lead").trim(),
      quantity: String(quantity || 1),
      hs_product_id: String(productId || "").trim(),
      // "price" exists in most portals; if yours rejects it, fallback removes it automatically
      price: String(price),
    };

    const r = await fetchJson("https://api.hubapi.com/crm/v3/objects/line_items", {
      method: "POST",
      headers: { ...hsAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });

    if (r.ok && r.json?.id) return r.json;

    // fallback: remove unknown properties if HubSpot complains
    const patched = await (async () => {
      // try again without price first
      const props2 = { name: props.name, quantity: props.quantity, hs_product_id: props.hs_product_id };
      const r2 = await fetchJson("https://api.hubapi.com/crm/v3/objects/line_items", {
        method: "POST",
        headers: { ...hsAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: props2 }),
      });
      return r2;
    })();

    if (!patched.ok || !patched.json?.id) {
      throw new Error(`Create line item failed (${patched.status}): ${patched.text || JSON.stringify(patched.json)}`);
    }
    return patched.json;
  }

  async function patchLineItem(lineItemId, props) {
    return patchWithFallback("line_items", lineItemId, props);
  }

  // ---------- Association (ROBUST) ----------
  async function associateDefault(lineItemId, dealId) {
    // No associationTypeId required
    const url =
      `https://api.hubapi.com/crm/v4/objects/line_items/${encodeURIComponent(lineItemId)}` +
      `/associations/default/deals/${encodeURIComponent(dealId)}`;

    const r = await fetchJson(url, { method: "PUT", headers: { ...hsAuth } });
    return r;
  }

  async function getLineItemDealAssociationTypeId() {
    // Try string object types first
    let r = await fetchJson("https://api.hubapi.com/crm/v4/associations/line_items/deals/labels", {
      method: "GET",
      headers: { ...hsAuth },
    });

    let results = r.json?.results || [];
    if (!r.ok || !results.length) {
      // Fallback to objectTypeId form: line_items = 0-8, deals = 0-3
      r = await fetchJson("https://api.hubapi.com/crm/v4/associations/0-8/0-3/labels", {
        method: "GET",
        headers: { ...hsAuth },
      });
      results = r.json?.results || [];
    }

    const pick =
      results.find((x) => String(x.associationCategory || x.category || "").toUpperCase() === "HUBSPOT_DEFINED") ||
      results[0];

    const typeId = pick?.associationTypeId ?? pick?.typeId ?? pick?.id ?? null;
    if (!typeId) {
      throw new Error("Could not determine line_item→deal associationTypeId");
    }
    return Number(typeId);
  }

  async function associateViaTypeId(lineItemId, dealId, typeId) {
    const url =
      `https://api.hubapi.com/crm/v3/objects/line_items/${encodeURIComponent(lineItemId)}` +
      `/associations/deals/${encodeURIComponent(dealId)}/${encodeURIComponent(String(typeId))}`;

    const r = await fetchJson(url, { method: "PUT", headers: { ...hsAuth } });
    return r;
  }

  async function ensureAssociation(lineItemId, dealId) {
    const d = await associateDefault(lineItemId, dealId);
    if (d.ok) return { ok: true, mode: "default" };

    // If default association route isn’t available, fall back to typeId
    const typeId = await getLineItemDealAssociationTypeId();
    const r = await associateViaTypeId(lineItemId, dealId, typeId);
    if (!r.ok) {
      throw new Error(
        `Associate line_item→deal failed (${r.status}): ${r.text || JSON.stringify(r.json)}`
      );
    }
    return { ok: true, mode: "typeId", associationTypeId: typeId };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const deal_id = String(body.deal_id || "").trim();
    const lead_id = String(body.lead_id || "").trim();
    const lead_price = safeNum(body.lead_price, 0);
    const line_item_name = String(body.line_item_name || "").trim() || "Home Secure Lead";
    const dealname_suggested = String(body.dealname_suggested || "").trim();

    if (!deal_id) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing deal_id" }) };
    }
    if (!lead_id) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing lead_id" }) };
    }
    if (!lead_price || lead_price < 1) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing/invalid lead_price" }) };
    }

    // 1) Ensure Product (unique per lead)
    let product = await findProductBySku(lead_id);
    if (!product) {
      product = await createProduct({ sku: lead_id, name: line_item_name, price: lead_price });
    } else {
      // Patch product price/name (best effort)
      await patchWithFallback("products", product.id, { name: line_item_name, price: String(lead_price) });
    }
    const productId = String(product.id).trim();

    // 2) Find existing line item on deal (idempotent) or create
    const assoc = await getDealLineItems(deal_id);
    let lineItemId = assoc.ids?.[0] || "";

    if (lineItemId) {
      await patchLineItem(lineItemId, {
        name: line_item_name,
        quantity: "1",
        hs_product_id: productId,
        price: String(lead_price),
      });
    } else {
      const li = await createLineItem({
        name: line_item_name,
        productId,
        price: lead_price,
        quantity: 1,
      });
      lineItemId = String(li.id).trim();
      // Associate it to the deal
      await ensureAssociation(lineItemId, deal_id);
    }

    // 3) Patch deal amount + (optional) dealname if placeholder
    await patchWithFallback("deals", deal_id, {
      amount: String(lead_price),
      lead_status: "Listed",
      listing_status: "Awaiting Payment",
    });
    await maybePatchDealName(deal_id, dealname_suggested);

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        deal_id,
        lead_id,
        lead_price,
        product_id: productId,
        line_item_id: lineItemId,
      }),
    };
  } catch (err) {
    console.error("ensure-line-item error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        error: "ensure-line-item failed",
        detail: String(err?.message || err),
      }),
    };
  }
}
