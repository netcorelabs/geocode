// netlify/functions/hubspot-sync.js
// v3 — HARDENED: deal creation never blocked by contact/association failures
// Goals:
//  ✅ Always return a deal_id when possible
//  ✅ Create/reuse ONE Deal per lead_id (idempotent)
//  ✅ Best-effort Contact upsert + association (does NOT block deal creation)
//  ✅ Best-effort Line Item create/reuse + association (does NOT block deal creation)
//  ✅ Returns warnings[] so HSRESULTS can still proceed + you can debug
//
// Expected env:
//   HUBSPOT_PRIVATE_APP_TOKEN (required)
//   HUBSPOT_DEAL_PIPELINE_ID (optional)
//   HUBSPOT_DEAL_STAGE_QUALIFIED (optional)
//   HUBSPOT_DEAL_AMOUNT_DEFAULT (optional; default 400)

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
    const origin = (originRaw || "").trim();
    const allowOrigin = origin ? (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]) : "*";
    return {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Vary": "Origin",
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    };
  }

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  }
  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
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
    return { ok: res.ok, status: res.status, json, text, headers: res.headers };
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
  async function hsPut(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "PUT", headers: hsAuth });
  }

  // Patch deal but ignore missing properties (if a portal doesn’t have them)
  async function patchDealWithFallback(dealId, properties) {
    const attempt = async (props) =>
      hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: props });

    let r = await attempt(properties);
    if (r.ok) return r;

    const badProps = new Set();
    for (const e of (r.json?.errors || [])) {
      if (e?.code !== "PROPERTY_DOESNT_EXIST") continue;
      const pn = e?.context?.propertyName;
      if (Array.isArray(pn)) pn.forEach((x) => x && badProps.add(String(x)));
      else if (typeof pn === "string" && pn.trim()) badProps.add(pn.trim());
    }

    if (badProps.size) {
      const filtered = Object.fromEntries(Object.entries(properties).filter(([k]) => !badProps.has(k)));
      if (Object.keys(filtered).length) return attempt(filtered);
    }
    return r;
  }

  async function findDealByLeadId(leadId) {
    if (!leadId) return null;

    // 1) Exact match on lead_id property (best)
    const exact = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["dealname", "lead_id", "pipeline", "dealstage"],
      sorts: ["-hs_lastmodifieddate"],
      limit: 1,
    });
    if (exact.ok && exact.json?.results?.[0]) return exact.json.results[0];

    // 2) Fallback: dealname contains leadId
    const contains = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "dealname", operator: "CONTAINS_TOKEN", value: leadId }] }],
      properties: ["dealname", "lead_id", "pipeline", "dealstage"],
      sorts: ["-hs_lastmodifieddate"],
      limit: 1,
    });
    return (contains.ok && contains.json?.results?.[0]) ? contains.json.results[0] : null;
  }

  async function createDeal(props) {
    const r = await hsPost("/crm/v3/objects/deals", { properties: props });
    if (!r.ok || !r.json?.id) throw new Error(`Create deal failed (${r.status}): ${r.text || JSON.stringify(r.json)}`);
    return String(r.json.id);
  }

  async function findLineItemByLeadToken(leadId) {
    if (!leadId) return null;
    const s = await hsPost("/crm/v3/objects/line_items/search", {
      filterGroups: [{ filters: [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: leadId }] }],
      properties: ["name", "price", "quantity", "hs_currency"],
      sorts: ["-hs_lastmodifieddate"],
      limit: 1,
    });
    return (s.ok && s.json?.results?.[0]) ? s.json.results[0] : null;
  }

  async function createLineItem(props) {
    const r = await hsPost("/crm/v3/objects/line_items", { properties: props });
    if (!r.ok || !r.json?.id) throw new Error(`Create line item failed (${r.status}): ${r.text || JSON.stringify(r.json)}`);
    return String(r.json.id);
  }

  async function associateDefault(fromType, fromId, toType, toId) {
    if (!fromId || !toId) return { ok: false, skipped: true };
    const path = `/crm/v4/objects/${encodeURIComponent(fromType)}/${encodeURIComponent(fromId)}` +
                 `/associations/default/${encodeURIComponent(toType)}/${encodeURIComponent(toId)}`;
    const r = await hsPut(path);
    return { ok: r.ok, status: r.status, text: r.text, json: r.json };
  }

  async function safeUpsertContactByEmail(props) {
    const email = String(props.email || "").trim();
    if (!email) return { id: "", warn: "no_email" };

    // 1) search
    const s = await hsPost("/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email", "firstname", "lastname"],
      limit: 1,
    });

    const existingId = (s.ok && s.json?.results?.[0]?.id) ? String(s.json.results[0].id) : "";

    // 2) update if exists
    if (existingId) {
      const u = await hsPatch(`/crm/v3/objects/contacts/${encodeURIComponent(existingId)}`, { properties: props });
      if (u.ok) return { id: existingId, warn: "" };
      return { id: existingId, warn: `contact_patch_failed_${u.status}` };
    }

    // 3) create
    const c = await hsPost("/crm/v3/objects/contacts", { properties: props });
    if (c.ok && c.json?.id) return { id: String(c.json.id), warn: "" };

    return { id: "", warn: `contact_create_failed_${c.status}` };
  }

  function parseBody() {
    if (event.httpMethod === "GET") return null;
    try { return JSON.parse(event.body || "{}"); } catch { return {}; }
  }

  function readLeadFromQuery() {
    const qs = event.queryStringParameters || {};
    return String(qs.lead_id || "").trim();
  }

  // optional: return portalId for debug (best-effort)
  async function tryPortalInfo() {
    // Some accounts allow this, some don't; never fail the request
    const r = await hsGet("/integrations/v1/me");
    const portalId = r.ok ? (r.json?.portalId ?? r.json?.portal_id ?? null) : null;
    return { ok: r.ok, portalId, status: r.status };
  }

  const warnings = [];
  let dealId = "";
  let contactId = "";
  let lineItemId = "";

  try {
    // GET = lookup mode
    if (event.httpMethod === "GET") {
      const lead_id = readLeadFromQuery();
      if (!lead_id) {
        return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing lead_id" }) };
      }
      const deal = await findDealByLeadId(lead_id);
      if (!deal?.id) {
        return { statusCode: 404, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal not found", lead_id }) };
      }
      return { statusCode: 200, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ ok: true, lead_id, deal_id: String(deal.id) }) };
    }

    const body = parseBody() || {};

    const email = String(body.email || "").trim();
    const lead_id = String(body.lead_id || "").trim() || String(Date.now());
    const firstname = String(body.firstname || "").trim();
    const lastname  = String(body.lastname  || "").trim();
    const phone     = String(body.phone     || "").trim();

    const street_address = String(body.street_address || body.address || "").trim();
    const city = String(body.city || "").trim();
    const state_code = String(body.state_code || body.state || "").trim().toUpperCase();
    const postal_code = String(body.postal_code || body.zip || "").trim();
    const country = String(body.country || body.country_region || "USA").trim();

    const amount = Number(body.amount || body.lead_price || AMOUNT_DEFAULT) || AMOUNT_DEFAULT;
    const currency = String(body.currency || "USD").trim() || "USD";

    // =========================
    // 1) Deal: find or create FIRST (so contacts don't block deals)
    // =========================
    let deal = await findDealByLeadId(lead_id);
    dealId = deal?.id ? String(deal.id) : "";

    const dealname = `Exclusive Lead - ${postal_code || "NA"} - ${lead_id}`;

    if (!dealId) {
      const props = {
        dealname,
        amount: String(amount),
        ...(PIPELINE_ID ? { pipeline: PIPELINE_ID } : {}),
        ...(STAGE_ID ? { dealstage: STAGE_ID } : {}),
      };
      dealId = await createDeal(props);
    } else {
      // best-effort update; don't fail on 404 here because we will fallback to create
      const up = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
        properties: {
          dealname,
          amount: String(amount),
          ...(PIPELINE_ID ? { pipeline: PIPELINE_ID } : {}),
          ...(STAGE_ID ? { dealstage: STAGE_ID } : {}),
        },
      });
      if (!up.ok && up.status === 404) {
        warnings.push("deal_update_404_recreating");
        const props = {
          dealname,
          amount: String(amount),
          ...(PIPELINE_ID ? { pipeline: PIPELINE_ID } : {}),
          ...(STAGE_ID ? { dealstage: STAGE_ID } : {}),
        };
        dealId = await createDeal(props);
      } else if (!up.ok) {
        warnings.push(`deal_update_failed_${up.status}`);
      }
    }

    // Ensure lead_id property exists for lookup
    const patch1 = await patchDealWithFallback(dealId, {
      lead_id,
      hs_lead_id: lead_id,
      lead_status: String(body.lead_status || "Qualified Lead (SQL)"),
    });
    if (!patch1.ok) warnings.push(`deal_patch_meta_failed_${patch1.status}`);

    // =========================
    // 2) Contact: best-effort upsert + association
    // =========================
    if (email) {
      const cu = await safeUpsertContactByEmail({
        email,
        ...(firstname ? { firstname } : {}),
        ...(lastname ? { lastname } : {}),
        ...(phone ? { phone } : {}),
        ...(street_address ? { address: street_address } : {}),
        ...(city ? { city } : {}),
        ...(state_code ? { state: state_code } : {}),
        ...(postal_code ? { zip: postal_code } : {}),
        ...(country ? { country } : {}),
      }).catch((e) => ({ id: "", warn: "contact_exception_" + String(e?.message || e) }));

      contactId = String(cu.id || "");
      if (cu.warn) warnings.push(cu.warn);

      if (contactId) {
        const a = await associateDefault("contacts", contactId, "deals", dealId);
        if (!a.ok && !a.skipped) warnings.push(`assoc_contact_deal_failed_${a.status}`);
      }
    } else {
      warnings.push("no_email_contact_skipped");
    }

    // =========================
    // 3) Line Item: best-effort create/reuse + association
    // =========================
    try {
      const existingLI = await findLineItemByLeadToken(lead_id);
      lineItemId = existingLI?.id ? String(existingLI.id) : "";

      if (!lineItemId) {
        const lineItemName = `Exclusive Lead — ${postal_code || "NA"} — ${lead_id}`;
        lineItemId = await createLineItem({
          name: lineItemName,
          quantity: "1",
          price: String(amount),
          hs_currency: currency,
          recurringbillingfrequency: "one_time",
        });
      }
      const a2 = await associateDefault("deals", dealId, "line_items", lineItemId);
      if (!a2.ok && !a2.skipped) warnings.push(`assoc_deal_lineitem_failed_${a2.status}`);
    } catch (e) {
      warnings.push("line_item_failed_" + String(e?.message || e));
    }

    // =========================
    // 4) Best-effort description patch (doesn't block)
    // =========================
    const desc = [
      "Lead created/confirmed.",
      `lead_id: ${lead_id}`,
      contactId ? `contact_id: ${contactId}` : "contact_id: (none)",
      lineItemId ? `line_item_id: ${lineItemId}` : "line_item_id: (none)",
      `amount: ${amount} ${currency}`,
    ].join("\n");

    const patch2 = await patchDealWithFallback(dealId, { description: desc });
    if (!patch2.ok) warnings.push(`deal_patch_desc_failed_${patch2.status}`);

    const portalInfo = await tryPortalInfo().catch(()=>({ok:false, portalId:null, status:null}));

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        lead_id,
        deal_id: dealId,
        contact_id: contactId || null,
        line_item_id: lineItemId || null,
        dealname,
        amount,
        currency,
        warnings,
        portal: portalInfo?.portalId ?? null,
      }),
    };

  } catch (err) {
    // If we created a deal but failed later, return it anyway so the front-end can proceed.
    const portalInfo = await tryPortalInfo().catch(()=>({ok:false, portalId:null, status:null}));

    return {
      statusCode: dealId ? 200 : 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: !!dealId,
        error: "hubspot-sync failed",
        detail: String(err?.message || err),
        lead_id: (event.httpMethod === "POST") ? (safeExtractLead(event.body) || null) : null,
        deal_id: dealId || null,
        contact_id: contactId || null,
        line_item_id: lineItemId || null,
        warnings,
        portal: portalInfo?.portalId ?? null,
      }),
    };
  }

  function safeExtractLead(bodyRaw){
    try{
      const b = JSON.parse(bodyRaw || "{}");
      return String(b.lead_id || "").trim() || null;
    }catch(e){ return null; }
  }
}
