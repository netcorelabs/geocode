// netlify/functions/hubspot-sync.js
import crypto from "node:crypto";

export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "https://www.netcoreleads.com",
    "https://netcoreleads.com",
    "https://api.netcoreleads.com",
    "https://hubspotgate.netlify.app",
  ];

  function corsHeaders(origin) {
    const safeOrigin = origin || allowedOrigins[0];
    const allowedOrigin = allowedOrigins.includes(safeOrigin) ? safeOrigin : allowedOrigins[0];
    return {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
    };
  }

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: "Method Not Allowed" };
  }

  const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";
  if (!HS_TOKEN) {
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }),
    };
  }

  const HS_HEADERS = { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" };

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  function normalizeSpaces(str) {
    return String(str || "").replace(/\s+/g, " ").trim();
  }
  function safeZip3(zip) {
    const m = String(zip || "").match(/\b(\d{3})\d{2}(?:-\d{4})?\b/);
    return m ? m[1] : "";
  }
  function normalizeOwnership(v) {
    const s = normalizeSpaces(v);
    const low = s.toLowerCase();
    if (low.startsWith("own")) return "Owner";
    if (low.startsWith("rent")) return "Renter";
    return s;
  }
  function normalizeTimeline(v) {
    const s = normalizeSpaces(v);
    const low = s.toLowerCase();
    if (low === "asap" || low.includes("a.s.a.p")) return "ASAP";
    if (low.includes("1") && low.includes("week")) return "1 Week";
    if ((low.includes("2") && low.includes("3") && low.includes("week")) || low.includes("2-3")) return "2 - 3 Weeks";
    if (low.includes("30") && (low.includes("day") || low.includes("+"))) return "30 Days +";
    return s;
  }

  function computeLeadPrice(payload, risk) {
    const explicit = Number(payload.lead_price ?? payload.leadPrice ?? payload.price ?? NaN);
    if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);

    const timeLine = normalizeTimeline(payload.time_line);
    const own = normalizeOwnership(payload.home_ownership);
    const riskScore = Number(payload.hsc_risk_score ?? risk?.scoring?.riskScore ?? NaN);

    const base = 85;
    const bump = Number.isFinite(riskScore) ? Math.max(0, Math.min(100, riskScore)) * 1.2 : 40;

    const timelineMult =
      timeLine === "ASAP" ? 1.4 :
      timeLine === "1 Week" ? 1.25 :
      timeLine === "2 - 3 Weeks" ? 1.1 :
      timeLine === "30 Days +" ? 0.9 : 1.0;

    const ownerMult = own === "Owner" ? 1.15 : 1.0;

    const raw = (base + bump) * timelineMult * ownerMult;
    const clamped = Math.max(49, Math.min(399, raw));
    return Math.round(clamped / 5) * 5;
  }

  async function hsPost(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "POST",
      headers: HS_HEADERS,
      body: JSON.stringify(body),
    });
  }
  async function hsPatch(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "PATCH",
      headers: HS_HEADERS,
      body: JSON.stringify(body),
    });
  }
  async function hsGet(path) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${HS_TOKEN}` },
    });
  }

  async function findContactIdByEmail(email) {
    const r = await hsPost("/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email"],
      limit: 1,
    });
    return r.ok && r.json?.results?.[0]?.id ? r.json.results[0].id : null;
  }

  async function upsertContact(email, properties) {
    const id = await findContactIdByEmail(email);
    if (!id) {
      const created = await hsPost("/crm/v3/objects/contacts", { properties });
      return created.ok ? created.json?.id : null;
    }
    await hsPatch(`/crm/v3/objects/contacts/${id}`, { properties });
    return id;
  }

  async function findDealByLeadId(leadId) {
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id", "listing_status", "lead_price"],
      limit: 1,
    });
    return r.ok && r.json?.results?.[0] ? r.json.results[0] : null;
  }

  async function associateDealToContact(dealId, contactId) {
    await hsPost("/crm/v3/associations/deals/contacts/batch/create", {
      inputs: [{ from: { id: String(dealId) }, to: { id: String(contactId) }, type: "deal_to_contact" }],
    });
  }

  async function getLineItemAssociations(dealId) {
    const r = await hsGet(`/crm/v3/objects/deals/${dealId}/associations/line_items`);
    const ids = (r.json?.results || []).map((x) => x.id).filter(Boolean);
    return ids;
  }

  async function createLineItemForDeal({ dealId, leadId, price, description, name }) {
    // Create + associate in one call using associationTypeId 20 (line item -> deal)
    const r = await hsPost("/crm/v3/objects/line_items", {
      properties: {
        name,
        description,
        quantity: 1,
        price: price,
        hs_sku: `LEAD-${leadId}`,
      },
      associations: [
        {
          to: { id: Number(dealId) },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 20 }],
        },
      ],
    });
    return r.ok ? r.json?.id : null;
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const payload = body.payload || {};
    const risk = body.risk || null;

    const email = normalizeSpaces(payload.email);
    if (!email) {
      return {
        statusCode: 400,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Missing payload.email" }),
      };
    }

    const lead_id =
      normalizeSpaces(payload.lead_id) ||
      (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const home_ownership = normalizeOwnership(payload.home_ownership);
    const time_line = normalizeTimeline(payload.time_line);

    const city = normalizeSpaces(payload.city || "");
    const stateCode = normalizeSpaces(payload.state_code || payload.state || "");
    const zip = normalizeSpaces(payload.postal_code || payload.zip || "");
    const zip3 = safeZip3(zip);
    const redacted_location = [city, stateCode].filter(Boolean).join(", ") + (zip3 ? ` ${zip3}xx` : "");

    const lead_price = computeLeadPrice(payload, risk);

    // Contact upsert
    const contactId = await upsertContact(email, {
      firstname: payload.firstname || "",
      lastname: payload.lastname || "",
      email,
      phone: payload.phone || "",
      address: payload.street_address || payload.address || "",
      city,
      state: stateCode,
      zip,
      home_ownership,
      time_line,
      hsc_property_address: payload.hsc_property_address || payload.address || "",
      hsc_risk_score: payload.hsc_risk_score ?? "",
      hsc_devices: payload.hsc_devices || payload.deviceSummary || payload.selectedItems || "",
      hsc_monthly: payload.hsc_monthly ?? payload.monthly ?? "",
      hsc_upfront: payload.hsc_upfront ?? payload.upfront ?? "",
    });

    // Deal create/update (Qualified)
    const dealname = `Security Lead — ${redacted_location || "Location"} — ${time_line || "—"} — ${home_ownership || "—"}`;
    const pipeline = process.env.HUBSPOT_DEAL_PIPELINE_ID || "";
    const stageQualified = process.env.HUBSPOT_DEAL_STAGE_QUALIFIED || "";

    const dealProps = {
      dealname,
      ...(pipeline ? { pipeline } : {}),
      ...(stageQualified ? { dealstage: stageQualified } : {}),
      lead_id,
      listing_status: "Qualified",
      lead_price: String(lead_price),
      redacted_location,
      time_line,
      home_ownership,
    };

    const existingDeal = await findDealByLeadId(lead_id);
    let dealId = null;

    if (!existingDeal?.id) {
      const created = await hsPost("/crm/v3/objects/deals", { properties: dealProps });
      dealId = created.ok ? created.json?.id : null;
      if (dealId && contactId) await associateDealToContact(dealId, contactId);
    } else {
      dealId = existingDeal.id;
      await hsPatch(`/crm/v3/objects/deals/${dealId}`, { properties: dealProps });
    }

    // Line item (unique product per lead)
    let lineItemId = null;
    if (dealId) {
      const existingLineItems = await getLineItemAssociations(dealId);
      if (!existingLineItems.length) {
        lineItemId = await createLineItemForDeal({
          dealId,
          leadId: lead_id,
          price: lead_price,
          name: `Exclusive Lead — ${redacted_location} — ${time_line} — ${home_ownership}`,
          description: `Redacted listing: ${redacted_location} | Timeline: ${time_line} | Ownership: ${home_ownership}`,
        });

        // Optional: store line item id on deal if you created a property lead_line_item_id
        if (lineItemId) {
          await hsPatch(`/crm/v3/objects/deals/${dealId}`, { properties: { lead_line_item_id: String(lineItemId) } })
            .catch(() => {});
        }
      } else {
        lineItemId = existingLineItems[0];
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ ok: true, lead_id, deal_id: dealId, line_item_id: lineItemId, lead_price }),
    };
  } catch (err) {
    console.error("hubspot-sync error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: err.message }),
    };
  }
}
