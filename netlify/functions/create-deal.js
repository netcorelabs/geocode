// netlify/functions/create-deal.js
// Creates (or reuses) a HubSpot Deal when the calculator submits.
// Idempotent by lead_id: if a deal already exists with the same lead_id, returns it.
// Also upserts the contact by email and associates deal ↔ contact.
//
// Required env:
//   HUBSPOT_PRIVATE_APP_TOKEN
//
// Optional env:
//   HUBSPOT_DEAL_PIPELINE_ID          (default: first pipeline returned by HubSpot if not provided)
//   HUBSPOT_DEAL_STAGE_ID             (default: first stage in pipeline if not provided)
//   HUBSPOT_DEAL_OWNER_ID             (optional)
//   HUBSPOT_DEAL_NAME_PREFIX          (default: "HSC Lead")
//   HUBSPOT_DEAL_LEAD_ID_PROPERTY     (default: "lead_id")   // must exist as a Deal property in HubSpot
//   HUBSPOT_CONTACT_LEAD_ID_PROPERTY  (default: "lead_id")   // must exist as a Contact property in HubSpot (optional)
//
// Security note:
// - Keep the private app token ONLY in Netlify env vars.
//
// Client call example:
// fetch("https://api.netcoreleads.com/.netlify/functions/create-deal", { method:"POST", headers:{...}, body: JSON.stringify(payload)})

export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "https://www.netcoreleads.com",
    "https://netcoreleads.com",
    "http://localhost:3000",
    "http://localhost:8888",
  ];

  const origin = event.headers?.origin || event.headers?.Origin || "";
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  const CORS = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Method not allowed" }),
    };
  }

  const TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!TOKEN) {
    return {
      statusCode: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }),
    };
  }

  const DEAL_PIPELINE_ID = (process.env.HUBSPOT_DEAL_PIPELINE_ID || "").trim();
  const DEAL_STAGE_ID = (process.env.HUBSPOT_DEAL_STAGE_ID || "").trim();
  const DEAL_OWNER_ID = (process.env.HUBSPOT_DEAL_OWNER_ID || "").trim();
  const NAME_PREFIX = (process.env.HUBSPOT_DEAL_NAME_PREFIX || "HSC Lead").trim();

  const DEAL_LEAD_ID_PROP = (process.env.HUBSPOT_DEAL_LEAD_ID_PROPERTY || "lead_id").trim();
  const CONTACT_LEAD_ID_PROP = (process.env.HUBSPOT_CONTACT_LEAD_ID_PROPERTY || "lead_id").trim();

  const baseHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
  };

  const json = (obj) => ({
    statusCode: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  });

  const jsonErr = (statusCode, obj) => ({
    statusCode,
    headers: { ...CORS, "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  });

  const safeParse = (s) => {
    try {
      return JSON.parse(s || "{}");
    } catch {
      return {};
    }
  };

  async function readText(r) {
    try {
      return await r.text();
    } catch {
      return "";
    }
  }

  async function hsFetch(path, { method = "GET", body = null } = {}) {
    const url = `https://api.hubapi.com${path}`;
    const r = await fetch(url, {
      method,
      headers: baseHeaders,
      body: body ? JSON.stringify(body) : null,
    });
    const t = await readText(r);
    let j = null;
    try {
      j = t ? JSON.parse(t) : null;
    } catch {
      j = null;
    }
    return { ok: r.ok, status: r.status, json: j, text: t };
  }

  function normalizeString(v) {
    return String(v || "").trim();
  }

  function normalizeNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function buildDealName({ lead_id, email, street_address, city, state_code, postal_code }) {
    const bits = [];
    const addr = [street_address, city, state_code, postal_code].filter(Boolean).join(", ");
    if (addr) bits.push(addr);
    if (email) bits.push(email);
    const suffix = lead_id ? `(${lead_id.slice(0, 8)})` : "";
    return `${NAME_PREFIX} ${suffix}${bits.length ? " — " + bits.join(" • ") : ""}`.trim();
  }

  async function findDealByLeadId(lead_id) {
    if (!lead_id) return "";
    // Search deals by custom property: DEAL_LEAD_ID_PROP
    const r = await hsFetch("/crm/v3/objects/deals/search", {
      method: "POST",
      body: {
        filterGroups: [
          {
            filters: [
              {
                propertyName: DEAL_LEAD_ID_PROP,
                operator: "EQ",
                value: lead_id,
              },
            ],
          },
        ],
        properties: [DEAL_LEAD_ID_PROP, "dealname"],
        limit: 1,
      },
    });

    const id = r.json?.results?.[0]?.id;
    return id ? String(id) : "";
  }

  async function upsertContactByEmail(payload) {
    const email = normalizeString(payload.email);
    if (!email) return { contact_id: "", created: false };

    // 1) search contact by email
    const srch = await hsFetch("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: {
        filterGroups: [
          { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
        ],
        properties: ["email"],
        limit: 1,
      },
    });

    const existingId = srch.json?.results?.[0]?.id ? String(srch.json.results[0].id) : "";

    // Build contact properties
    const props = {};
    if (payload.firstname) props.firstname = normalizeString(payload.firstname);
    if (payload.lastname) props.lastname = normalizeString(payload.lastname);
    if (payload.phone) props.phone = normalizeString(payload.phone);

    // HubSpot address format the way you’ve been enforcing:
    // street_address, city, state, zip, country
    if (payload.street_address) props.address = normalizeString(payload.street_address);
    if (payload.city) props.city = normalizeString(payload.city);
    if (payload.state_code || payload.state) props.state = normalizeString(payload.state_code || payload.state);
    if (payload.postal_code || payload.zip) props.zip = normalizeString(payload.postal_code || payload.zip);
    if (payload.country || payload.country_region) props.country = normalizeString(payload.country || payload.country_region);

    // Keep full formatted address in your custom field (if you have it)
    if (payload.hsc_property_address) props.hsc_property_address = normalizeString(payload.hsc_property_address);

    // Optional: store lead_id on contact if your portal has that property
    if (payload.lead_id && CONTACT_LEAD_ID_PROP) {
      props[CONTACT_LEAD_ID_PROP] = normalizeString(payload.lead_id);
    }

    // Additional useful custom fields if you have them
    if (payload.home_ownership) props.home_ownership = normalizeString(payload.home_ownership);
    if (payload.home_size) props.home_size = normalizeString(payload.home_size);
    if (payload.hsc_devices) props.hsc_devices = normalizeString(payload.hsc_devices);
    if (payload.hsc_monthly != null) props.hsc_monthly = String(normalizeNumber(payload.hsc_monthly));
    if (payload.hsc_upfront != null) props.hsc_upfront = String(normalizeNumber(payload.hsc_upfront));
    if (payload.hsc_risk_score != null) props.hsc_risk_score = String(normalizeNumber(payload.hsc_risk_score));
    if (payload.hsc_system_tier) props.hsc_system_tier = normalizeString(payload.hsc_system_tier);

    if (existingId) {
      // Update
      await hsFetch(`/crm/v3/objects/contacts/${existingId}`, {
        method: "PATCH",
        body: { properties: props },
      });
      return { contact_id: existingId, created: false };
    }

    // Create
    const created = await hsFetch("/crm/v3/objects/contacts", {
      method: "POST",
      body: { properties: { email, ...props } },
    });

    const newId = created.json?.id ? String(created.json.id) : "";
    return { contact_id: newId, created: true };
  }

  async function getDefaultPipelineAndStage() {
    // If env vars not provided, pick the first pipeline and first stage.
    // This keeps your function working even before you configure env.
    const pipe = await hsFetch("/crm/v3/pipelines/deals", { method: "GET" });
    const firstPipeline = pipe.json?.results?.[0];
    const pipelineId = firstPipeline?.id ? String(firstPipeline.id) : "";
    const stageId = firstPipeline?.stages?.[0]?.id ? String(firstPipeline.stages[0].id) : "";
    return { pipelineId, stageId };
  }

  async function createDeal(payload) {
    const lead_id = normalizeString(payload.lead_id);
    const email = normalizeString(payload.email);

    // Idempotency: reuse existing deal by lead_id
    const existing = await findDealByLeadId(lead_id);
    if (existing) return { deal_id: existing, reused: true };

    const defaults = await getDefaultPipelineAndStage();
    const pipelineId = DEAL_PIPELINE_ID || defaults.pipelineId || "";
    const stageId = DEAL_STAGE_ID || defaults.stageId || "";

    const amount =
      normalizeNumber(payload.amount) ||
      normalizeNumber(payload.hsc_upfront) ||
      normalizeNumber(payload.upfront) ||
      0;

    const dealProps = {
      dealname: buildDealName({
        lead_id,
        email,
        street_address: normalizeString(payload.street_address),
        city: normalizeString(payload.city),
        state_code: normalizeString(payload.state_code || payload.state),
        postal_code: normalizeString(payload.postal_code || payload.zip),
      }),
      pipeline: pipelineId || undefined,
      dealstage: stageId || undefined,
      amount: amount ? String(amount) : undefined,
    };

    // Add lead_id to deal (custom property must exist in your portal)
    if (lead_id) dealProps[DEAL_LEAD_ID_PROP] = lead_id;

    // Helpful custom props (only apply if your portal has them)
    if (payload.hsc_property_address) dealProps.hsc_property_address = normalizeString(payload.hsc_property_address);
    if (payload.hsc_devices) dealProps.hsc_devices = normalizeString(payload.hsc_devices);
    if (payload.hsc_monthly != null) dealProps.hsc_monthly = String(normalizeNumber(payload.hsc_monthly));
    if (payload.hsc_upfront != null) dealProps.hsc_upfront = String(normalizeNumber(payload.hsc_upfront));
    if (payload.hsc_risk_score != null) dealProps.hsc_risk_score = String(normalizeNumber(payload.hsc_risk_score));

    if (DEAL_OWNER_ID) dealProps.hubspot_owner_id = DEAL_OWNER_ID;

    // Remove undefined keys
    Object.keys(dealProps).forEach((k) => {
      if (dealProps[k] === undefined || dealProps[k] === "") delete dealProps[k];
    });

    const created = await hsFetch("/crm/v3/objects/deals", {
      method: "POST",
      body: { properties: dealProps },
    });

    const id = created.json?.id ? String(created.json.id) : "";
    return { deal_id: id, reused: false, raw: created };
  }

  async function associateDealToContact(deal_id, contact_id) {
    if (!deal_id || !contact_id) return;
    // HubSpot v4 association endpoint
    // Default association type works for standard objects with "deal_to_contact"
    await hsFetch(
      `/crm/v4/objects/deals/${deal_id}/associations/contacts/${contact_id}/deal_to_contact`,
      { method: "PUT" }
    );
  }

  // ---------------------------
  // MAIN
  // ---------------------------
  const payload = safeParse(event.body);

  // Required minimum
  const email = normalizeString(payload.email);
  const lead_id = normalizeString(payload.lead_id);

  if (!email) {
    return jsonErr(400, { ok: false, error: "Missing required field: email" });
  }
  if (!lead_id) {
    return jsonErr(400, { ok: false, error: "Missing required field: lead_id (use crypto.randomUUID() on client)" });
  }

  try {
    // 1) Contact upsert
    const { contact_id } = await upsertContactByEmail(payload);

    // 2) Deal create (or reuse by lead_id)
    const dealRes = await createDeal(payload);
    const deal_id = dealRes.deal_id;

    if (!deal_id) {
      return jsonErr(502, {
        ok: false,
        error: "Deal creation failed",
        detail: dealRes.raw?.text || dealRes.raw?.json || null,
      });
    }

    // 3) Associate deal ↔ contact
    try {
      await associateDealToContact(deal_id, contact_id);
    } catch (e) {
      // Not fatal — deal still created
      console.warn("Association failed", e);
    }

    return json({
      ok: true,
      deal_id,
      contact_id,
      reused: !!dealRes.reused,
      lead_id,
    });
  } catch (err) {
    return jsonErr(500, {
      ok: false,
      error: "Unhandled error",
      detail: String(err?.message || err),
    });
  }
}
