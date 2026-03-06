// netlify/functions/create-deal.js
// Hardened HubSpot Deal creator for calculator submit
// Idempotent by lead_id
//
// REQUIRED ENV:
//   HUBSPOT_PRIVATE_APP_TOKEN
//
// OPTIONAL ENV:
//   HUBSPOT_DEAL_PIPELINE_ID
//   HUBSPOT_DEAL_STAGE_ID
//   HUBSPOT_DEAL_OWNER_ID
//   HUBSPOT_DEAL_NAME_PREFIX=HSC Lead
//   HUBSPOT_DEAL_LEAD_ID_PROPERTY=lead_id
//   HUBSPOT_CONTACT_LEAD_ID_PROPERTY=lead_id

export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "http://localhost:8888",
    "http://localhost:3000"
  ];

  const origin = event.headers?.origin || event.headers?.Origin || "";
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  const CORS = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!TOKEN) {
    return json(500, { ok: false, error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" });
  }

  const DEAL_PIPELINE_ID = String(process.env.HUBSPOT_DEAL_PIPELINE_ID || "").trim();
  const DEAL_STAGE_ID = String(process.env.HUBSPOT_DEAL_STAGE_ID || "").trim();
  const DEAL_OWNER_ID = String(process.env.HUBSPOT_DEAL_OWNER_ID || "").trim();
  const DEAL_NAME_PREFIX = String(process.env.HUBSPOT_DEAL_NAME_PREFIX || "HSC Lead").trim();
  const DEAL_LEAD_ID_PROPERTY = String(process.env.HUBSPOT_DEAL_LEAD_ID_PROPERTY || "lead_id").trim();
  const CONTACT_LEAD_ID_PROPERTY = String(process.env.HUBSPOT_CONTACT_LEAD_ID_PROPERTY || "lead_id").trim();

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${TOKEN}`
  };

  function json(statusCode, obj) {
    return {
      statusCode,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify(obj)
    };
  }

  function safeParse(s) {
    try { return JSON.parse(s || "{}"); } catch { return {}; }
  }

  function s(v) {
    return String(v ?? "").trim();
  }

  function n(v) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }

  async function readText(r) {
    try { return await r.text(); } catch { return ""; }
  }

  async function hsFetch(path, options = {}) {
    const method = options.method || "GET";
    const body = options.body ? JSON.stringify(options.body) : undefined;
    const r = await fetch(`https://api.hubapi.com${path}`, {
      method,
      headers,
      body
    });
    const text = await readText(r);
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: r.ok, status: r.status, text, data };
  }

  const payload = safeParse(event.body);

  const lead_id = s(payload.lead_id);
  const email = s(payload.email);

  if (!lead_id) {
    return json(400, { ok: false, error: "Missing required field: lead_id" });
  }
  if (!email) {
    return json(400, { ok: false, error: "Missing required field: email" });
  }

  const debug = {
    lead_id,
    email,
    steps: []
  };

  try {
    // --------------------------------------------------
    // 1) Find existing deal by lead_id
    // --------------------------------------------------
    debug.steps.push("search_deal_by_lead_id");

    const dealSearch = await hsFetch("/crm/v3/objects/deals/search", {
      method: "POST",
      body: {
        filterGroups: [
          {
            filters: [
              {
                propertyName: DEAL_LEAD_ID_PROPERTY,
                operator: "EQ",
                value: lead_id
              }
            ]
          }
        ],
        properties: ["dealname", DEAL_LEAD_ID_PROPERTY],
        limit: 1
      }
    });

    if (dealSearch.ok && Array.isArray(dealSearch.data?.results) && dealSearch.data.results[0]?.id) {
      const existingDealId = String(dealSearch.data.results[0].id);
      debug.steps.push("existing_deal_found");

      const contactResult = await upsertContact(payload);
      if (contactResult.contact_id) {
        await associateDealToContact(existingDealId, contactResult.contact_id);
      }

      return json(200, {
        ok: true,
        reused: true,
        deal_id: existingDealId,
        contact_id: contactResult.contact_id || "",
        debug
      });
    }

    // --------------------------------------------------
    // 2) Upsert contact
    // --------------------------------------------------
    const contactResult = await upsertContact(payload);
    debug.steps.push("contact_upserted");

    // --------------------------------------------------
    // 3) Resolve pipeline/stage
    // --------------------------------------------------
    const pipelineInfo = await getPipelineAndStage();
    const pipeline = DEAL_PIPELINE_ID || pipelineInfo.pipelineId || "";
    const dealstage = DEAL_STAGE_ID || pipelineInfo.stageId || "";

    debug.pipeline = pipeline;
    debug.dealstage = dealstage;

    // --------------------------------------------------
    // 4) Build minimal SAFE deal payload first
    // --------------------------------------------------
    const dealName = buildDealName(payload);

    const minimalDealProps = {
      dealname: dealName
    };

    if (pipeline) minimalDealProps.pipeline = pipeline;
    if (dealstage) minimalDealProps.dealstage = dealstage;
    if (DEAL_OWNER_ID) minimalDealProps.hubspot_owner_id = DEAL_OWNER_ID;
    if (n(payload.hsc_upfront || payload.upfront || payload.amount || 0) > 0) {
      minimalDealProps.amount = String(n(payload.hsc_upfront || payload.upfront || payload.amount || 0));
    }

    // add lead_id property if your portal has it
    minimalDealProps[DEAL_LEAD_ID_PROPERTY] = lead_id;

    debug.steps.push("create_deal_minimal");

    let createDeal = await hsFetch("/crm/v3/objects/deals", {
      method: "POST",
      body: { properties: minimalDealProps }
    });

    // --------------------------------------------------
    // 5) If minimal create fails, retry without custom lead_id property
    //    This catches the case where lead_id property does not actually exist.
    // --------------------------------------------------
    if (!createDeal.ok) {
      debug.minimal_create_error = {
        status: createDeal.status,
        text: createDeal.text
      };

      const fallbackProps = {
        dealname: dealName
      };
      if (pipeline) fallbackProps.pipeline = pipeline;
      if (dealstage) fallbackProps.dealstage = dealstage;
      if (DEAL_OWNER_ID) fallbackProps.hubspot_owner_id = DEAL_OWNER_ID;
      if (n(payload.hsc_upfront || payload.upfront || payload.amount || 0) > 0) {
        fallbackProps.amount = String(n(payload.hsc_upfront || payload.upfront || payload.amount || 0));
      }

      debug.steps.push("create_deal_fallback_no_custom_lead_id");

      createDeal = await hsFetch("/crm/v3/objects/deals", {
        method: "POST",
        body: { properties: fallbackProps }
      });

      if (!createDeal.ok) {
        return json(502, {
          ok: false,
          error: "Deal creation failed",
          detail: createDeal.data || createDeal.text,
          debug
        });
      }
    }

    const deal_id = s(createDeal.data?.id);
    if (!deal_id) {
      return json(502, {
        ok: false,
        error: "HubSpot did not return a deal id",
        detail: createDeal.data || createDeal.text,
        debug
      });
    }

    debug.deal_id = deal_id;

    // --------------------------------------------------
    // 6) Patch optional fields AFTER creation
    //    If optional custom fields are invalid, deal still exists.
    // --------------------------------------------------
    const optionalProps = {};

    if (s(payload.hsc_property_address)) optionalProps.hsc_property_address = s(payload.hsc_property_address);
    if (s(payload.hsc_devices)) optionalProps.hsc_devices = s(payload.hsc_devices);
    if (s(payload.hsc_system_tier)) optionalProps.hsc_system_tier = s(payload.hsc_system_tier);
    if (s(payload.hsc_install)) optionalProps.hsc_install = s(payload.hsc_install);
    if (s(payload.hsc_monitoring)) optionalProps.hsc_monitoring = s(payload.hsc_monitoring);
    if (s(payload.home_ownership)) optionalProps.home_ownership = s(payload.home_ownership);
    if (s(payload.time_line)) optionalProps.time_line = s(payload.time_line);
    if (s(payload.notes)) optionalProps.notes = s(payload.notes);
    if (payload.hsc_upfront != null) optionalProps.hsc_upfront = String(n(payload.hsc_upfront));
    if (payload.hsc_monthly != null) optionalProps.hsc_monthly = String(n(payload.hsc_monthly));

    if (Object.keys(optionalProps).length) {
      debug.steps.push("patch_optional_deal_fields");

      const patchDeal = await hsFetch(`/crm/v3/objects/deals/${deal_id}`, {
        method: "PATCH",
        body: { properties: optionalProps }
      });

      if (!patchDeal.ok) {
        debug.optional_patch_error = {
          status: patchDeal.status,
          text: patchDeal.text
        };
      }
    }

    // --------------------------------------------------
    // 7) Associate deal ↔ contact
    // --------------------------------------------------
    if (contactResult.contact_id) {
      debug.steps.push("associate_deal_contact");
      const assoc = await associateDealToContact(deal_id, contactResult.contact_id);
      if (!assoc.ok) {
        debug.association_error = assoc.error || assoc.text || "Unknown association error";
      }
    }

    return json(200, {
      ok: true,
      reused: false,
      deal_id,
      contact_id: contactResult.contact_id || "",
      debug
    });

  } catch (err) {
    return json(500, {
      ok: false,
      error: "Unhandled error",
      detail: String(err?.message || err),
      debug
    });
  }

  // ======================================================
  // Helpers
  // ======================================================

  async function upsertContact(p) {
    const email = s(p.email);
    const result = { contact_id: "", created: false };

    // search by email
    const search = await hsFetch("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: {
        filterGroups: [
          {
            filters: [
              { propertyName: "email", operator: "EQ", value: email }
            ]
          }
        ],
        properties: ["email", "firstname", "lastname"],
        limit: 1
      }
    });

    const existingId = s(search.data?.results?.[0]?.id);

    const minimalProps = {
      email
    };
    if (s(p.firstname)) minimalProps.firstname = s(p.firstname);
    if (s(p.lastname)) minimalProps.lastname = s(p.lastname);
    if (s(p.phone)) minimalProps.phone = s(p.phone);

    if (existingId) {
      const update = await hsFetch(`/crm/v3/objects/contacts/${existingId}`, {
        method: "PATCH",
        body: { properties: minimalProps }
      });

      result.contact_id = existingId;

      if (!update.ok) {
        debug.contact_update_error = {
          status: update.status,
          text: update.text
        };
      } else {
        // optional patch separately
        await patchOptionalContactFields(existingId, p);
      }

      return result;
    }

    const create = await hsFetch("/crm/v3/objects/contacts", {
      method: "POST",
      body: { properties: minimalProps }
    });

    if (!create.ok) {
      throw new Error(`Contact create failed (${create.status}): ${create.text}`);
    }

    result.contact_id = s(create.data?.id);
    result.created = true;

    if (result.contact_id) {
      await patchOptionalContactFields(result.contact_id, p);
    }

    return result;
  }

  async function patchOptionalContactFields(contactId, p) {
    const optional = {};

    if (s(p.street_address)) optional.address = s(p.street_address);
    if (s(p.city)) optional.city = s(p.city);
    if (s(p.state_code || p.state)) optional.state = s(p.state_code || p.state);
    if (s(p.postal_code || p.zip)) optional.zip = s(p.postal_code || p.zip);
    if (s(p.country || p.country_region)) optional.country = s(p.country || p.country_region);
    if (s(p.hsc_property_address)) optional.hsc_property_address = s(p.hsc_property_address);
    if (s(p.home_ownership)) optional.home_ownership = s(p.home_ownership);
    if (s(p.hsc_devices)) optional.hsc_devices = s(p.hsc_devices);
    if (p.hsc_upfront != null) optional.hsc_upfront = String(n(p.hsc_upfront));
    if (p.hsc_monthly != null) optional.hsc_monthly = String(n(p.hsc_monthly));
    if (s(p.hsc_system_tier)) optional.hsc_system_tier = s(p.hsc_system_tier);
    if (CONTACT_LEAD_ID_PROPERTY) optional[CONTACT_LEAD_ID_PROPERTY] = s(p.lead_id);

    if (!Object.keys(optional).length) return;

    const patch = await hsFetch(`/crm/v3/objects/contacts/${contactId}`, {
      method: "PATCH",
      body: { properties: optional }
    });

    if (!patch.ok) {
      debug.contact_optional_patch_error = {
        status: patch.status,
        text: patch.text
      };
    }
  }

  async function getPipelineAndStage() {
    if (DEAL_PIPELINE_ID && DEAL_STAGE_ID) {
      return { pipelineId: DEAL_PIPELINE_ID, stageId: DEAL_STAGE_ID };
    }

    const r = await hsFetch("/crm/v3/pipelines/deals");
    if (!r.ok) {
      debug.pipeline_fetch_error = {
        status: r.status,
        text: r.text
      };
      return { pipelineId: "", stageId: "" };
    }

    const firstPipeline = r.data?.results?.[0];
    return {
      pipelineId: s(firstPipeline?.id),
      stageId: s(firstPipeline?.stages?.[0]?.id)
    };
  }

  function buildDealName(p) {
    const nameBits = [];
    const prefix = DEAL_NAME_PREFIX || "HSC Lead";
    const shortLead = s(p.lead_id).slice(0, 8);

    const fullName = [s(p.firstname), s(p.lastname)].filter(Boolean).join(" ").trim();
    if (fullName) nameBits.push(fullName);

    const addr = s(p.hsc_property_address) ||
      [s(p.street_address), s(p.city), s(p.state_code || p.state), s(p.postal_code || p.zip)]
        .filter(Boolean)
        .join(", ");

    if (addr) nameBits.push(addr);

    if (s(p.email)) nameBits.push(s(p.email));

    return `${prefix} (${shortLead})${nameBits.length ? " — " + nameBits.join(" • ") : ""}`.trim();
  }

  async function associateDealToContact(dealId, contactId) {
    try {
      const r = await hsFetch(
        `/crm/v4/objects/deals/${dealId}/associations/default/contacts/${contactId}`,
        { method: "PUT" }
      );

      if (!r.ok) {
        return { ok: false, status: r.status, text: r.text };
      }

      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }
}
