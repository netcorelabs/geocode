// netlify/functions/hubspot-sync.js
// Creates (or reuses) ONE Deal per lead_id, plus ONE Line Item, and associates them.
// Deal naming: "Exclusive Lead - {ZIP} - {contactId} - {lead_id}"
//
// Expected env:
//   HUBSPOT_PRIVATE_APP_TOKEN (required)
//   HUBSPOT_DEAL_PIPELINE_ID (optional)
//   HUBSPOT_DEAL_STAGE_QUALIFIED (optional)
//   HUBSPOT_DEAL_AMOUNT_DEFAULT (optional; default 400)

exports.handler = async (event) => {
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

  const PIPELINE_ID = String(process.env.HUBSPOT_DEAL_PIPELINE_ID || "").trim();
  const STAGE_ID = String(process.env.HUBSPOT_DEAL_STAGE_QUALIFIED || "").trim();
  const AMOUNT_DEFAULT = Number(process.env.HUBSPOT_DEAL_AMOUNT_DEFAULT || 400) || 400;

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
    return fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: { ...hsAuth } });
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
  async function hsPut(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "PUT", headers: { ...hsAuth } });
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

  async function upsertContactByEmail(props) {
    const email = String(props.email || "").trim();
    if (!email) throw new Error("Missing email");

    const s = await hsPost("/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email", "firstname", "lastname"],
      limit: 1,
    });

    const existingId = s.ok && s.json?.results?.[0]?.id ? String(s.json.results[0].id) : "";
    if (existingId) {
      await fetchJson(`https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(existingId)}`, {
        method: "PATCH",
        headers: { ...hsAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: props }),
      });
      return existingId;
    }

    const c = await hsPost("/crm/v3/objects/contacts", { properties: props });
    if (!c.ok || !c.json?.id) throw new Error(`Create contact failed (${c.status}): ${c.text || JSON.stringify(c.json)}`);
    return String(c.json.id);
  }

  async function findExistingDealByLeadToken(leadId) {
    if (!leadId) return null;
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [
        { filters: [{ propertyName: "dealname", operator: "CONTAINS_TOKEN", value: leadId }] }
      ],
      properties: ["dealname", "amount", "pipeline", "dealstage"],
      limit: 1,
    });
    return (r.ok && r.json?.results?.[0]) ? r.json.results[0] : null;
  }

  
  async function findExistingLineItemByLeadToken(leadId) {
    if (!leadId) return null;
    const r = await hsPost("/crm/v3/objects/line_items/search", {
      filterGroups: [
        { filters: [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: leadId }] }
      ],
      properties: ["name", "price", "quantity", "hs_currency"],
      limit: 1,
    });
    return (r.ok && r.json?.results?.[0]) ? r.json.results[0] : null;
  }

async function createDeal(props) {
    const r = await hsPost("/crm/v3/objects/deals", { properties: props });
    if (!r.ok || !r.json?.id) throw new Error(`Create deal failed (${r.status}): ${r.text || JSON.stringify(r.json)}`);
    return String(r.json.id);
  }

  async function createLineItem(props) {
    const r = await hsPost("/crm/v3/objects/line_items", { properties: props });
    if (!r.ok || !r.json?.id) throw new Error(`Create line item failed (${r.status}): ${r.text || JSON.stringify(r.json)}`);
    return String(r.json.id);
  }

  async function associateDefault(fromType, fromId, toType, toId) {
    // CRM v4 default association (no associationTypeId required)
    const path = `/crm/v4/objects/${encodeURIComponent(fromType)}/${encodeURIComponent(fromId)}` +
                 `/associations/default/${encodeURIComponent(toType)}/${encodeURIComponent(toId)}`;
    const r = await hsPut(path);
    if (!r.ok) throw new Error(`Associate ${fromType}→${toType} failed (${r.status}): ${r.text || JSON.stringify(r.json)}`);
    return true;
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const email = String(body.email || "").trim();
    if (!email) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing email" }) };
    }

    const lead_id = String(body.lead_id || "").trim() || String(Date.now());
    const firstname = String(body.firstname || "").trim();
    const lastname  = String(body.lastname || "").trim();
    const phone     = String(body.phone || "").trim();

    const street_address = String(body.street_address || body.address || "").trim();
    const city = String(body.city || "").trim();
    const state_code = String(body.state_code || body.state || "").trim().toUpperCase();
    const postal_code = String(body.postal_code || body.zip || "").trim();
    const country = String(body.country || body.country_region || "USA").trim();

    const amount = Number(body.amount || body.lead_price || AMOUNT_DEFAULT) || AMOUNT_DEFAULT;
    const currency = String(body.currency || "USD").trim() || "USD";

    // 1) Upsert contact in HubSpot account #2
    const contactId = await upsertContactByEmail({
      email,
      ...(firstname ? { firstname } : {}),
      ...(lastname ? { lastname } : {}),
      ...(phone ? { phone } : {}),
      ...(street_address ? { address: street_address } : {}),
      ...(city ? { city } : {}),
      ...(state_code ? { state: state_code } : {}),
      ...(postal_code ? { zip: postal_code } : {}),
      ...(country ? { country } : {}),
    });

    // 2) Find or create deal (one per lead_id)
    let deal = await findExistingDealByLeadToken(lead_id);
    let dealId = deal?.id ? String(deal.id) : "";

    const dealname = `Exclusive Lead - ${postal_code || "NA"} - ${contactId} - ${lead_id}`;

    if (!dealId) {
      const props = {
        dealname,
        amount: String(amount),
        ...(PIPELINE_ID ? { pipeline: PIPELINE_ID } : {}),
        ...(STAGE_ID ? { dealstage: STAGE_ID } : {}),
      };
      dealId = await createDeal(props);
    } else {
      await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
        properties: {
          dealname,
          amount: String(amount),
          ...(PIPELINE_ID ? { pipeline: PIPELINE_ID } : {}),
          ...(STAGE_ID ? { dealstage: STAGE_ID } : {})
        },
      });
    }

    // 3) Associate deal to contact
    await associateDefault("contacts", contactId, "deals", dealId);

    // 4) Find or create ONE line item per lead_id, then associate to deal
    const lineItemName = `Exclusive Lead — ${postal_code || "NA"} — ${lead_id}`;
    let lineItem = await findExistingLineItemByLeadToken(lead_id);
    let lineItemId = lineItem?.id ? String(lineItem.id) : "";

    if (!lineItemId) {
      lineItemId = await createLineItem({
        name: lineItemName,
        quantity: "1",
        price: String(amount),
        hs_currency: currency,
        recurringbillingfrequency: "one_time",
      });
    } else {
      // Best-effort update (won't fail the flow)
      await hsPatch(`/crm/v3/objects/line_items/${encodeURIComponent(lineItemId)}`, {
        properties: {
          name: lineItemName,
          price: String(amount),
          hs_currency: currency,
        },
      }).catch(()=>{});
    }

    await associateDefault("deals", dealId, "line_items", lineItemId);

    // 5) Best-effort patch (won't fail if properties don't exist)
    await patchDealWithFallback(dealId, {
      lead_id,
      hs_lead_id: lead_id,
      lead_status: "Qualified Lead (SQL)",
      description:
        `Lead created/confirmed.\n` +
        `lead_id: ${lead_id}\n` +
        `contact_id: ${contactId}\n` +
        `line_item_id: ${lineItemId}\n` +
        `amount: ${amount} ${currency}\n`,
    });

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        lead_id,
        deal_id: dealId,
        contact_id: contactId,
        line_item_id: lineItemId,
        dealname,
        amount,
        currency,
      }),
    };
  } catch (err) {
    console.error("hubspot-sync error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "hubspot-sync failed", detail: String(err?.message || err) }),
    };
  }
}
