// netlify/functions/hubspot-sync.js  (CommonJS - CORS SAFE)
exports.handler = async function handler(event) {
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

  const headers = corsHeaders(event.headers?.origin);

  // ✅ Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
    if (!HS_TOKEN) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
    }

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

    // -----------------------------
    // Helpers: build "City, ST 300xx"
    // -----------------------------
    function zip3xx(zip) {
      const z = String(zip || "").trim();
      const m = z.match(/\b(\d{3})\d{2}(?:-\d{4})?\b/);
      return m ? `${m[1]}xx` : "";
    }

    function extractFromAddress(addressRaw) {
      const address = String(addressRaw || "").trim();
      if (!address) return { city: "", state: "", zip: "" };

      const parts = address.split(",").map(s => s.trim()).filter(Boolean);

      // Find the part containing "ST 12345"
      let state = "", zip = "", idx = -1;
      for (let i = 0; i < parts.length; i++) {
        const m = parts[i].match(/\b([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/);
        if (m) { state = m[1]; zip = m[2]; idx = i; break; }
      }

      // City is usually right before "ST ZIP"
      const city = (idx > 0) ? (parts[idx - 1] || "") : "";
      return { city, state, zip };
    }

    function buildDealName(payload) {
      let city  = String(payload.city || "").trim();
      let state = String(payload.state_code || payload.state || "").trim();
      let zip   = String(payload.postal_code || payload.zip || "").trim();

      // Fallback: parse full address string
      if ((!city || !state || !zip) && (payload.hsc_property_address || payload.address)) {
        const parsed = extractFromAddress(payload.hsc_property_address || payload.address);
        city  = city  || parsed.city;
        state = state || parsed.state;
        zip   = zip   || parsed.zip;
      }

      const z3 = zip3xx(zip);

      let display = "";
      if (city && state && z3) display = `${city}, ${state} ${z3}`;
      else if (city && state)  display = `${city}, ${state}`;
      else if (city && z3)     display = `${city} ${z3}`;
      else display = "";

      const leadShort = String(payload.lead_id || "").slice(0, 8);
      if (!display) display = leadShort ? `Lead ${leadShort}` : "Lead";

      return `Security Lead — ${display}`;
    }

    // -----------------------------
    // Read request body
    // -----------------------------
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

    const payload = (body.payload && typeof body.payload === "object") ? body.payload : {};
    const leadId = String(payload.lead_id || "").trim();

    if (!leadId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing payload.lead_id" }) };
    }

    const dealname = buildDealName(payload);

    // -----------------------------
    // Upsert deal by lead_id
    // -----------------------------
    async function findDealByLeadId(leadId) {
      const r = await hsPost("/crm/v3/objects/deals/search", {
        filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
        properties: ["dealname", "lead_id"],
        limit: 1,
      });
      return (r.ok && r.json?.results?.[0]) ? r.json.results[0] : null;
    }

    const existing = await findDealByLeadId(leadId);

    let dealId = "";
    if (existing?.id) {
      dealId = String(existing.id);

      // Patch safe properties only
      const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
        properties: { dealname, lead_id: leadId }
      });

      if (!patched.ok) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Deal update failed", detail: patched.text }) };
      }
    } else {
      const created = await hsPost("/crm/v3/objects/deals", {
        properties: { dealname, lead_id: leadId }
      });

      if (!created.ok || !created.json?.id) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Deal create failed", detail: created.text }) };
      }

      dealId = String(created.json.id);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        deal_id: dealId,
        dealname,
        lead_id: leadId,
      }),
    };
  } catch (err) {
    // ✅ Even crashes return CORS headers
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err?.message || err) }),
    };
  }
};
