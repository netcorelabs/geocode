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
    const safeOrigin = (origin || "").trim() || allowedOrigins[0];
    const allowedOrigin = allowedOrigins.includes(safeOrigin) ? safeOrigin : allowedOrigins[0];
    return {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Headers": "Content-Type",
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

  const HS_HEADERS = { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" };

  async function readText(res) {
    try { return await res.text(); } catch { return ""; }
  }

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await readText(res);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  const hsGet = (path) => fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: { Authorization: `Bearer ${HS_TOKEN}` } });
  const hsPost = (path, body) =>
    fetchJson(`https://api.hubapi.com${path}`, { method: "POST", headers: HS_HEADERS, body: JSON.stringify(body) });
  const hsPatch = (path, body) =>
    fetchJson(`https://api.hubapi.com${path}`, { method: "PATCH", headers: HS_HEADERS, body: JSON.stringify(body) });

  function normalizeSpaces(str) { return String(str || "").replace(/\s+/g, " ").trim(); }

  function safeZip3(zip) {
    const m = String(zip || "").match(/\b(\d{3})\d{2}(?:-\d{4})?\b/);
    return m ? m[1] : "";
  }

  function normalizeOwnership(v) {
    const s = normalizeSpaces(v);
    const low = s.toLowerCase();
    if (low.startsWith("own")) return "Owner";
    if (low.startsWith("rent")) return "Renter";
    return s || "Unknown";
  }

  function normalizeTimeline(v) {
    const s = normalizeSpaces(v);
    const low = s.toLowerCase();
    if (!s) return "Researching";
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

  // ---------- Deal property safety ----------
  async function dealPropertyExists(name) {
    const r = await hsGet(`/crm/v3/properties/deals/${encodeURIComponent(name)}`);
    return r.ok;
  }

  async function tryCreateDealProperty({ name, label, type, fieldType }) {
    // If your private app lacks permission for properties, this will fail; we treat as best-effort.
    const r = await hsPost("/crm/v3/properties/deals", {
      name,
      label,
      type,       // "string" | "number" | "enumeration" | etc.
      fieldType,  // "text" | "number" | "select" | etc.
      groupName: "dealinformation",
    });
    return r.ok;
  }

  async function ensureDealPropsBestEffort() {
    // Minimum required for your whole flow:
    // - lead_id: used by upload-deliverables and visitor-pdf-link search
    // - deliverable_pdf_file_id / deliverable_csv_file_id: set by upload-deliverables
    const desired = [
      { name: "lead_id", label: "Lead ID", type: "string", fieldType: "text", required: true },
      { name: "deliverable_pdf_file_id", label: "Deliverable PDF File ID", type: "string", fieldType: "text", required: false },
      { name: "deliverable_csv_file_id", label: "Deliverable CSV File ID", type: "string", fieldType: "text", required: false },

      // Nice-to-have listing fields (skip if not possible)
      { name: "lead_price", label: "Lead Price", type: "number", fieldType: "number", required: false },
      { name: "listing_status", label: "Listing Status", type: "string", fieldType: "text", required: false },
      { name: "redacted_location", label: "Redacted Location", type: "string", fieldType: "text", required: false },
      { name: "time_line", label: "Timeline", type: "string", fieldType: "text", required: false },
      { name: "home_ownership", label: "Home Ownership", type: "string", fieldType: "text", required: false },
    ];

    const exists = {};
    const created = {};
    const missingRequired = [];

    for (const p of desired) {
      const ok = await dealPropertyExists(p.name);
      if (ok) { exists[p.name] = true; continue; }

      const made = await tryCreateDealProperty(p);
      if (made) { created[p.name] = true; exists[p.name] = true; continue; }

      exists[p.name] = false;
      if (p.required) missingRequired.push(p.name);
    }

    return { exists, created, missingRequired };
  }

  function pickExistingProps(props, existsMap) {
    const out = {};
    const dropped = [];
    for (const [k, v] of Object.entries(props || {})) {
      if (existsMap && existsMap[k] === false) {
        dropped.push(k);
        continue;
      }
      // if unknown in map, keep it (no check), but our map covers everything we send.
      out[k] = v;
    }
    return { out, dropped };
  }

  async function findDealByLeadId(leadId) {
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id", "dealname"],
      limit: 1,
    });
    return r.ok && r.json?.results?.[0] ? r.json.results[0] : null;
  }

  async function getLineItemAssociations(dealId) {
    const r = await hsGet(`/crm/v3/objects/deals/${dealId}/associations/line_items`);
    return (r.json?.results || []).map((x) => x.id).filter(Boolean);
  }

  async function createLineItemForDeal({ dealId, leadId, price, description, name }) {
    // associationTypeId 20 = line item -> deal
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
    const options = body.options || {};

    // IMPORTANT: Default behavior = DO NOT upsert contacts in portal #2
    // You said contacts should be updated via HSC_FORM_ID (portal #1).
    const skip_contact = (options.skip_contact !== undefined) ? !!options.skip_contact : true;

    // We still require email to keep lead_id stable and to support your broader flow
    const email = normalizeSpaces(payload.email);
    if (!email) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing payload.email" }) };
    }

    // Keep stable lead_id if provided
    const lead_id =
      normalizeSpaces(payload.lead_id) ||
      (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const city = normalizeSpaces(payload.city || "");
    const stateCode = normalizeSpaces(payload.state_code || payload.state || "");
    const zip = normalizeSpaces(payload.postal_code || payload.zip || "");
    const zip3 = safeZip3(zip);
    const redacted_location = [city, stateCode].filter(Boolean).join(", ") + (zip3 ? ` ${zip3}xx` : "");

    const home_ownership = normalizeOwnership(payload.home_ownership);
    const time_line = normalizeTimeline(payload.time_line);
    const lead_price = computeLeadPrice(payload, risk);

    // Ensure deal properties exist (best effort) and never hard-fail on non-required fields
    const propCheck = await ensureDealPropsBestEffort();
    if (propCheck.missingRequired.length) {
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          error: "Missing required Deal properties in this HubSpot portal",
          portal_hint: "This is portal tied to HUBSPOT_PRIVATE_APP_TOKEN (account #2)",
          missing_required: propCheck.missingRequired,
          fix: "Create these Deal properties manually as Single-line text (lead_id is required).",
        }),
      };
    }

    // CONTACT UPSERT DISABLED BY DEFAULT (portal #2)
    // If you ever want to enable it, do it explicitly by passing options.skip_contact=false.
    if (!skip_contact) {
      // Minimal safe upsert using STANDARD contact properties ONLY (avoids custom property errors)
      // NOTE: This keeps it from breaking even if custom contact fields aren't created.
      const contactProps = {
        firstname: payload.firstname || "",
        lastname: payload.lastname || "",
        email,
        phone: payload.phone || "",
        address: payload.street_address || payload.address || "",
        city,
        state: stateCode,
        zip,
      };

      // find by email
      const contactSearch = await hsPost("/crm/v3/objects/contacts/search", {
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
        properties: ["email"],
        limit: 1,
      });

      const contactId = contactSearch.ok && contactSearch.json?.results?.[0]?.id ? contactSearch.json.results[0].id : null;

      if (!contactId) {
        await hsPost("/crm/v3/objects/contacts", { properties: contactProps });
      } else {
        await hsPatch(`/crm/v3/objects/contacts/${contactId}`, { properties: contactProps });
      }
    }

    // Deal props we WANT to write
    // Deal name format you requested: Security Lead — <City, ST ZIP3xx> — <deal_id>
    // We set a placeholder first, then after creation we patch dealname to include the real deal_id.
    const pipeline = process.env.HUBSPOT_DEAL_PIPELINE_ID || "default";
    const stageQualified = process.env.HUBSPOT_DEAL_STAGE_QUALIFIED || "appointmentscheduled";

    const initialDealName = `Security Lead — ${redacted_location || "Location"} — ${lead_id}`;

    const desiredDealProps = {
      dealname: initialDealName,               // always valid standard
      pipeline,                                // standard
      dealstage: stageQualified,               // standard
      lead_id,                                 // custom (required)
      listing_status: "Qualified",             // custom (optional)
      lead_price: String(lead_price),          // custom (optional)
      redacted_location,                       // custom (optional)
      time_line,                               // custom (optional)
      home_ownership,                          // custom (optional)
    };

    // Remove non-existing custom props (if create failed)
    const { out: dealProps, dropped: droppedDealProps } =
      pickExistingProps(desiredDealProps, propCheck.exists);

    // Upsert deal by lead_id
    const existingDeal = await findDealByLeadId(lead_id);
    let dealId = null;

    if (!existingDeal?.id) {
      const created = await hsPost("/crm/v3/objects/deals", { properties: dealProps });
      if (!created.ok || !created.json?.id) {
        return {
          statusCode: 500,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({ error: "Deal create failed", detail: created.text, droppedDealProps }),
        };
      }
      dealId = created.json.id;
    } else {
      dealId = existingDeal.id;
      const patched = await hsPatch(`/crm/v3/objects/deals/${dealId}`, { properties: dealProps });
      if (!patched.ok) {
        return {
          statusCode: 500,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({ error: "Deal update failed", detail: patched.text, droppedDealProps }),
        };
      }
    }

    // Patch dealname to include real deal_id (your requested naming)
    if (dealId) {
      const finalDealName = `Security Lead — ${redacted_location || "Location"} — ${dealId}`;
      await hsPatch(`/crm/v3/objects/deals/${dealId}`, { properties: { dealname: finalDealName } });
    }

    // Line item attach (avoid duplicates)
    let lineItemId = null;
    if (dealId) {
      const existingLineItems = await getLineItemAssociations(dealId);
      if (!existingLineItems.length) {
        lineItemId = await createLineItemForDeal({
          dealId,
          leadId: lead_id,
          price: lead_price,
          name: `Exclusive Lead — ${redacted_location || "Location"} — ${dealId}`,
          description: `Redacted listing: ${redacted_location || "—"} | Deal: ${dealId}`,
        });
      } else {
        lineItemId = existingLineItems[0];
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        lead_id,
        deal_id: dealId,
        line_item_id: lineItemId,
        lead_price,
        dropped_deal_properties: droppedDealProps,
        auto_created_deal_properties: Object.keys(propCheck.created || {}),
        skip_contact,
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
