// netlify/functions/hubspot-sync.js
export async function handler(event) {
  // ----------------------------
  // CORS
  // ----------------------------
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "https://www.netcoreleads.com",
    "https://netcoreleads.com",
    "https://api.netcoreleads.com",
  ];

  function corsHeaders(originRaw) {
    const origin = (originRaw || "").trim();
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

  // ----------------------------
  // Auth
  // ----------------------------
  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) {
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }),
    };
  }

  const hsHeaders = {
    Authorization: `Bearer ${HS_TOKEN}`,
    "Content-Type": "application/json",
  };

  async function readText(res) { try { return await res.text(); } catch { return ""; } }
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  const HS = {
    get: (path) => fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: hsHeaders }),
    post: (path, body) => fetchJson(`https://api.hubapi.com${path}`, { method: "POST", headers: hsHeaders, body: JSON.stringify(body) }),
    patch: (path, body) => fetchJson(`https://api.hubapi.com${path}`, { method: "PATCH", headers: hsHeaders, body: JSON.stringify(body) }),
    put: (path) => fetchJson(`https://api.hubapi.com${path}`, { method: "PUT", headers: hsHeaders }),
  };

  // ----------------------------
  // Helpers
  // ----------------------------
  function asStr(v) { return String(v ?? "").trim(); }
  function asNum(v, d = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }

  // Patch with fallback: if property doesn't exist, drop it and retry
  async function patchWithFallback(objectType, objectId, properties) {
    const attempt = async (props) =>
      HS.patch(`/crm/v3/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`, { properties: props });

    let r = await attempt(properties);
    if (r.ok) return r;

    const badProps = new Set(
      (r.json?.errors || [])
        .filter(e => e.code === "PROPERTY_DOESNT_EXIST")
        .flatMap(e => e.context?.propertyName || [])
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
    const r = await HS.post("/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email"],
      limit: 1,
    });
    return (r.ok && r.json?.results?.[0]?.id) ? String(r.json.results[0].id) : "";
  }

  async function findDealByLeadId(lead_id) {
    const r = await HS.post("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: lead_id }] }],
      properties: ["lead_id", "dealname", "amount"],
      limit: 1,
    });
    return (r.ok && r.json?.results?.[0]?.id) ? String(r.json.results[0].id) : "";
  }

  async function createDeal({ lead_id, dealname, amount }) {
    const r = await HS.post("/crm/v3/objects/deals", {
      properties: {
        lead_id,
        dealname,
        amount: String(Math.round(amount || 0)),
      }
    });
    if (!r.ok || !r.json?.id) throw new Error(`Create deal failed (${r.status}): ${r.text}`);
    return String(r.json.id);
  }

  async function createLineItem({ name, price, currency }) {
    // NOTE: Line Items usually expect: name, price, quantity, hs_currency
    const r = await HS.post("/crm/v3/objects/line_items", {
      properties: {
        name,
        price: String(asNum(price, 0)),
        quantity: "1",
        hs_currency: currency || "USD",
      }
    });
    if (!r.ok || !r.json?.id) throw new Error(`Create line item failed (${r.status}): ${r.text}`);
    return String(r.json.id);
  }

  async function getAssociationTypeId(from, to) {
    // Get labels (associationTypeId) from HubSpot
    const r = await fetchJson(`https://api.hubapi.com/crm/v4/associations/${encodeURIComponent(from)}/${encodeURIComponent(to)}/labels`, {
      method: "GET",
      headers: hsHeaders,
    });

    if (r.ok && Array.isArray(r.json?.results) && r.json.results.length) {
      // prefer HUBSPOT_DEFINED
      const pick = r.json.results.find(x => x.associationCategory === "HUBSPOT_DEFINED") || r.json.results[0];
      if (pick?.associationTypeId) return Number(pick.associationTypeId);
    }

    // Unknown fallback — but we'll still attempt batch create with this; if it fails we won't fail the whole sync
    return null;
  }

  async function associateV4Batch(fromType, toType, fromId, toId, associationTypeId) {
    // v4 batch create associations
    // POST /crm/v4/objects/{from}/{to}/batch/create
    const url = `https://api.hubapi.com/crm/v4/objects/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/batch/create`;
    const body = {
      inputs: [
        {
          from: { id: String(fromId) },
          to: { id: String(toId) },
          type: associationTypeId ? Number(associationTypeId) : undefined
        }
      ]
    };

    // If type is undefined, remove it (some accounts reject undefined fields)
    if (!associationTypeId) delete body.inputs[0].type;

    const r = await fetchJson(url, { method: "POST", headers: hsHeaders, body: JSON.stringify(body) });
    return r;
  }

  async function associateDealToContact(dealId, contactId) {
    // best-effort; don’t fail whole flow
    try {
      const assocTypeId = await getAssociationTypeId("deals", "contacts");
      if (assocTypeId) {
        const r = await associateV4Batch("deals", "contacts", dealId, contactId, assocTypeId);
        return r.ok;
      }
      // fallback to v3 PUT with a commonly-valid typeId (best effort)
      const r2 = await HS.put(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/contacts/${encodeURIComponent(contactId)}/3`);
      return r2.ok;
    } catch {
      return false;
    }
  }

  async function associateDealToLineItem(dealId, lineItemId) {
    // This is where you are currently failing. We will try multiple safe strategies and never throw.
    let association_ok = false;
    let association_error = "";

    try {
      const assocTypeId = await getAssociationTypeId("deals", "line_items");
      // 1) Preferred: v4 batch create with correct associationTypeId
      if (assocTypeId) {
        const r = await associateV4Batch("deals", "line_items", dealId, lineItemId, assocTypeId);
        if (r.ok) return { association_ok: true, association_error: "" };
        association_error = `v4 batch assoc failed (${r.status}): ${r.text}`;
      }

      // 2) Fallback: try v3 PUT using assocTypeId if we have it
      if (assocTypeId) {
        const r2 = await HS.put(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items/${encodeURIComponent(lineItemId)}/${encodeURIComponent(String(assocTypeId))}`);
        if (r2.ok) return { association_ok: true, association_error: "" };
        association_error = association_error || `v3 assoc failed (${r2.status}): ${r2.text}`;
      }

      // 3) Final fallback: try v3 PUT with common default 6 (may work in some portals)
      const r3 = await HS.put(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items/${encodeURIComponent(lineItemId)}/6`);
      if (r3.ok) return { association_ok: true, association_error: "" };
      association_error = association_error || `v3 assoc (type 6) failed (${r3.status}): ${r3.text}`;

    } catch (e) {
      association_error = String(e?.message || e);
    }

    return { association_ok, association_error };
  }

  // ----------------------------
  // Main
  // ----------------------------
  try {
    const body = JSON.parse(event.body || "{}");

    const email = asStr(body.email);
    const lead_id = asStr(body.lead_id) || String(Date.now());
    const dealname = asStr(body.dealname) || `HSC Lead ${lead_id}`;
    const line_item_name = asStr(body.line_item_name) || `HSC Lead Item ${lead_id}`;
    const lead_price = asNum(body.lead_price, 0);
    const currency = asStr(body.currency) || "USD";

    if (!email) {
      return {
        statusCode: 400,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Missing email" }),
      };
    }

    // 1) Deal idempotency by lead_id
    let dealId = await findDealByLeadId(lead_id);
    if (!dealId) {
      dealId = await createDeal({ lead_id, dealname, amount: lead_price });
    } else {
      // keep it updated, but don't crash if fields don't exist
      await patchWithFallback("deals", dealId, { dealname, amount: String(Math.round(lead_price)) });
    }

    // 2) Contact association (best effort)
    const contactId = await findContactIdByEmail(email);
    if (contactId) await associateDealToContact(dealId, contactId);

    // 3) Line item creation
    const lineItemId = await createLineItem({ name: line_item_name, price: lead_price, currency });

    // 4) Deal -> line item association (best effort, never fail whole call)
    const assoc = await associateDealToLineItem(dealId, lineItemId);

    // 5) Optional status (won’t crash if property missing)
    await patchWithFallback("deals", dealId, { lead_status: "Deliverables Processing" });

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        deal_id: dealId,
        line_item_id: lineItemId,
        association_ok: !!assoc.association_ok,
        association_error: assoc.association_error || ""
      }),
    };

  } catch (err) {
    console.error("hubspot-sync error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: String(err?.message || err) }),
    };
  }
}
