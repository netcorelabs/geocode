// netlify/functions/hubspot-sync.js
// Upsert HubSpot contact from HSC flow payload + risk.
// Requires env var: HUBSPOT_PRIVATE_APP_TOKEN
// Optional env var: HUBSPOT_PORTAL_ID (not required for CRM API upsert)

const ALLOWED_ORIGINS = [
  "https://www.homesecurecalculator.com",
  "https://homesecurecalculator.com",
  "https://hubspotgate.netlify.app",
];

const corsHeaders = (origin) => {
  const o = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
};

function json(statusCode, origin, bodyObj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
      ...extraHeaders,
    },
    body: JSON.stringify(bodyObj),
  };
}

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toISODateTime() {
  return new Date().toISOString();
}

// --- US State full name lookup (optional) ---
const US_STATE_NAMES = {
  AL:"Alabama", AK:"Alaska", AZ:"Arizona", AR:"Arkansas", CA:"California", CO:"Colorado", CT:"Connecticut",
  DE:"Delaware", FL:"Florida", GA:"Georgia", HI:"Hawaii", ID:"Idaho", IL:"Illinois", IN:"Indiana", IA:"Iowa",
  KS:"Kansas", KY:"Kentucky", LA:"Louisiana", ME:"Maine", MD:"Maryland", MA:"Massachusetts", MI:"Michigan",
  MN:"Minnesota", MS:"Mississippi", MO:"Missouri", MT:"Montana", NE:"Nebraska", NV:"Nevada", NH:"New Hampshire",
  NJ:"New Jersey", NM:"New Mexico", NY:"New York", NC:"North Carolina", ND:"North Dakota", OH:"Ohio", OK:"Oklahoma",
  OR:"Oregon", PA:"Pennsylvania", RI:"Rhode Island", SC:"South Carolina", SD:"South Dakota", TN:"Tennessee",
  TX:"Texas", UT:"Utah", VT:"Vermont", VA:"Virginia", WA:"Washington", WV:"West Virginia", WI:"Wisconsin", WY:"Wyoming",
  DC:"District of Columbia"
};

// =====================================================
//  HUBSPOT PROPERTY MAPPING (EDIT THIS IF NEEDED)
//  LEFT = our canonical keys (what we store in hsc_payload)
//  RIGHT = your HubSpot INTERNAL property names
//
//  IMPORTANT:
//  Your list includes many LABELS (e.g., "First Name").
//  HubSpot API needs INTERNAL names (e.g., "firstname").
// =====================================================
const PROP_MAP = {
  // Standard HubSpot contact props
  firstname: "firstname",
  lastname: "lastname",
  email: "email",
  city: "city",
  state_code: "state",       // State/Region Code (standard is "state" = abbreviation)
  state_name: "state_region",// IF you created a custom "State/Region" text prop, put its internal name here
  zip: "zip",                // postal code
  street_address: "address", // Street Address (ONLY number + street name)

  // Optional standard
  timezone: "time_zone",     // if you created custom "Time Zone" internal name; if not, delete this line
  ip_timezone: "ip_timezone",// if you created custom "IP Timezone" internal name; if not, delete this line
  ip_state_code: "ip_state_code_region_code", // custom internal name
  ip_state_name: "ip_state_region",           // custom internal name

  // Your HSC custom fields (these look like your internal names already)
  hsc_devices: "hsc_devices",
  hsc_monthly: "hsc_monthly",
  hsc_upfront: "hsc_upfront",
  hsc_property_address: "hsc_property_address",
  hsc_risk_score: "hsc_risk_score",
  hsc_system_tier: "hsc_system_tier",

  // Additional fields you listed (make sure internal names match)
  installation_tier: "installation_tier",
  installation_type: "installation_type",
  service_plan: "service_plan",
  system_tier: "system_tier",
  smart_locks: "smart_locks",

  // UTM fields (these look standard-ish / custom)
  utm_campaign: "utm_campaign",
  utm_content: "utm_content",
  utm_source: "utm_source",
  utm_term: "utm_term",
  utm_data: "utm_data",

  // If you truly want to write into Total Revenue (must exist as contact property)
  total_revenue: "total_revenue",

  // If you have these (otherwise remove)
  home_ownership: "home_ownership",
  home_size: "home_size",

  // You listed Solar fields; include only if you actually have these properties on contacts
  solar_installer: "solar_installer",
  solar_kw: "solar_kw",
};

// Allowlist of values we’ll actually send (prevents HubSpot 400 errors from unknown keys)
const CANONICAL_ALLOWLIST = new Set(Object.keys(PROP_MAP));

// Build hsc_devices string from structured deviceLines OR deviceSummary OR raw counts
function buildDeviceSummary(payload) {
  const dl = Array.isArray(payload.deviceLines) ? payload.deviceLines : null;
  if (dl && dl.length) {
    const parts = dl
      .filter(x => Number(x.qty) > 0)
      .map(x => `${safeStr(x.label)} x${Number(x.qty)}`);
    return parts.length ? parts.join(", ") : "No devices selected";
  }
  const s = safeStr(payload.deviceSummary || payload.hsc_devices);
  if (s) return s;

  // fallback from common keys
  const fallback = [];
  const pairs = [
    ["Indoor Cameras", payload.indoorCam],
    ["Outdoor Cameras", payload.outdoorCam],
    ["Video Doorbell", payload.doorbell],
    ["Smart Locks", payload.lock],
    ["Door Sensors", payload.doorSensor],
    ["Window Sensors", payload.windowSensor],
    ["Motion Sensors", payload.motion],
    ["Glass Break Sensors", payload.glass],
    ["Smoke/CO", payload.smoke],
    ["Water Leak", payload.water],
    ["Keypads", payload.keypad],
    ["Sirens", payload.siren],
  ];
  pairs.forEach(([label, v]) => {
    const n = Number(v || 0);
    if (n > 0) fallback.push(`${label} x${n}`);
  });
  return fallback.length ? fallback.join(", ") : "No devices selected";
}

function pickCanonical(body) {
  // Accept either { payload, risk } or raw payload
  const payload = body && typeof body === "object" ? (body.payload || body) : {};
  const risk = body && typeof body === "object" ? (body.risk || null) : null;
  return { payload, risk };
}

function normalizeCanonical(payload, risk) {
  // Canonical keys we will map to HubSpot
  const out = {};

  out.firstname = safeStr(payload.firstname || payload["First Name"]);
  out.lastname  = safeStr(payload.lastname  || payload["Last Name"]);
  out.email     = safeStr(payload.email     || payload["Email"]);
  out.city      = safeStr(payload.city      || payload["City"]);
  out.zip       = safeStr(payload.zip       || payload["postal code"] || payload.postal_code);

  // Address format requirement: ONLY street number + street name
  out.street_address = safeStr(
    payload.street_address ||
    payload.streetAddress ||
    payload["Street Address"] ||
    payload.address_line1 ||
    ""
  );

  // State code + name
  const st = safeStr(payload.state_code || payload.state || payload["State/Region Code"] || payload.state_region_code);
  out.state_code = st;
  out.state_name = safeStr(payload.state_name || payload["State/Region"] || US_STATE_NAMES[st] || "");

  // Timezones (from browser usually)
  out.timezone = safeStr(payload.timezone || payload["Time Zone"] || "");
  out.ip_timezone = safeStr(payload.ip_timezone || payload["IP Timezone"] || "");

  // IP State (we’ll default to address state unless you pass IP-derived values)
  out.ip_state_code = safeStr(payload.ip_state_code || payload["IP State Code/Region Code"] || st);
  out.ip_state_name = safeStr(payload.ip_state_name || payload["IP State/Region"] || (US_STATE_NAMES[out.ip_state_code] || ""));

  // HSC financials
  out.hsc_monthly = safeNum(payload.hsc_monthly ?? payload.monthly ?? 0);
  out.hsc_upfront = safeNum(payload.hsc_upfront ?? payload.upfront ?? 0);

  // Full formatted address (safe to store separately)
  out.hsc_property_address = safeStr(payload.hsc_property_address || payload.address_full || payload.address || payload.geo?.formatted || "");

  // Risk score
  const riskScore =
    (risk && risk.scoring && Number.isFinite(Number(risk.scoring.riskScore)) ? Number(risk.scoring.riskScore) : null) ??
    (Number.isFinite(Number(payload.hsc_risk_score)) ? Number(payload.hsc_risk_score) : null) ??
    null;

  if (riskScore !== null) out.hsc_risk_score = Math.round(riskScore);

  // System tier / plan / install
  out.hsc_system_tier = safeStr(payload.hsc_system_tier || payload.tierName || payload.tier || payload.systemTier || payload["System tier"] || payload["System tier"] || "");
  out.system_tier     = safeStr(payload.system_tier || payload["System tier"] || out.hsc_system_tier || "");
  out.service_plan    = safeStr(payload.service_plan || payload.monitoringName || payload.monitoring || payload.monitorPlan || payload["Service plan"] || "");
  out.installation_tier = safeStr(payload.installation_tier || payload.installName || payload.install || payload.installTier || payload["Installation tier"] || "");
  out.installation_type = safeStr(payload.installation_type || payload.installMode || payload["installation_type"] || payload["installation_type"] || "");

  // Locks count
  out.smart_locks = safeNum(payload.smart_locks ?? payload.lock ?? 0);

  // Home details (if you collect them)
  out.home_ownership = safeStr(payload.home_ownership || payload["Home Ownership"] || "");
  out.home_size = safeStr(payload.home_size || payload["Home size"] || "");

  // Devices summary string
  out.hsc_devices = buildDeviceSummary(payload);

  // UTMs
  out.utm_campaign = safeStr(payload.utm_campaign || payload.utm?.campaign || "");
  out.utm_content  = safeStr(payload.utm_content  || payload.utm?.content  || "");
  out.utm_source   = safeStr(payload.utm_source   || payload.utm?.source   || "");
  out.utm_term     = safeStr(payload.utm_term     || payload.utm?.term     || "");

  // Store “UTM Data” as a compact JSON string if you want
  const utmObj = {
    utm_source: out.utm_source,
    utm_campaign: out.utm_campaign,
    utm_content: out.utm_content,
    utm_term: out.utm_term,
    first_seen: safeStr(payload.utm_first_seen || ""),
    last_seen: safeStr(payload.utm_last_seen || ""),
  };
  out.utm_data = JSON.stringify(utmObj);

  // Total Revenue (optional) — many users set this elsewhere; only keep if you want it
  out.total_revenue = Math.round(out.hsc_upfront || 0);

  // (Solar fields ignored unless you use them)
  out.solar_installer = safeStr(payload.solar_installer || payload["Solar installer"] || "");
  out.solar_kw = safeStr(payload.solar_kw || payload["Solar kW"] || "");

  // Final: remove any keys not in allowlist OR empty strings (except email)
  const cleaned = {};
  for (const [k, v] of Object.entries(out)) {
    if (!CANONICAL_ALLOWLIST.has(k)) continue;
    if (k === "email") {
      if (safeStr(v)) cleaned[k] = safeStr(v);
      continue;
    }
    if (typeof v === "number") {
      cleaned[k] = v;
      continue;
    }
    const s = safeStr(v);
    if (s) cleaned[k] = s;
  }

  return cleaned;
}

function mapToHubSpotProps(canonical) {
  const props = {};
  for (const [canonKey, value] of Object.entries(canonical)) {
    const hsKey = PROP_MAP[canonKey];
    if (!hsKey) continue;
    props[hsKey] = value;
  }
  return props;
}

async function hsFetch(path, token, opts = {}) {
  const url = `https://api.hubapi.com${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const txt = await res.text();
  let jsonBody = null;
  try { jsonBody = txt ? JSON.parse(txt) : null; } catch {}
  return { ok: res.ok, status: res.status, body: jsonBody || txt };
}

async function findContactIdByEmail(email, token) {
  const searchBody = {
    filterGroups: [
      { filters: [{ propertyName: "email", operator: "EQ", value: email }] }
    ],
    properties: ["email"],
    limit: 1,
  };

  const r = await hsFetch("/crm/v3/objects/contacts/search", token, {
    method: "POST",
    body: JSON.stringify(searchBody),
  });

  if (!r.ok) return null;
  const id = r.body?.results?.[0]?.id || null;
  return id;
}

exports.handler = async function (event) {
  const origin = event.headers?.origin || event.headers?.Origin || "";

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, origin, { ok: false, error: "Use POST" });
  }

  try {
    const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
    if (!token) {
      return json(500, origin, { ok: false, error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" });
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const { payload, risk } = pickCanonical(body);

    const canonical = normalizeCanonical(payload, risk);
    const email = canonical.email;

    if (!email) {
      return json(400, origin, { ok: false, error: "Missing email" });
    }

    const properties = mapToHubSpotProps(canonical);

    // Upsert
    const existingId = await findContactIdByEmail(email, token);

    let result;
    if (existingId) {
      result = await hsFetch(`/crm/v3/objects/contacts/${existingId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ properties }),
      });
    } else {
      result = await hsFetch(`/crm/v3/objects/contacts`, token, {
        method: "POST",
        body: JSON.stringify({ properties }),
      });
    }

    if (!result.ok) {
      // Most common cause: a mapped property internal name doesn't exist
      return json(result.status || 400, origin, {
        ok: false,
        error: "HubSpot upsert failed",
        detail: result.body,
        hint: "Verify PROP_MAP internal property names exist in HubSpot (Settings → Properties).",
      });
    }

    return json(200, origin, {
      ok: true,
      mode: existingId ? "updated" : "created",
      email,
      syncedAt: toISODateTime(),
      sentProperties: Object.keys(properties),
    });
  } catch (e) {
    return json(500, origin, { ok: false, error: "Server error", detail: String(e?.message || e) });
  }
};
