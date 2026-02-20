// netlify/functions/submit-lead.js

export async function handler(event) {
  // Allowed domains for CORS
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://hubspotgate.netlify.app",
  ];

  function corsHeaders(origin) {
    const safeOrigin = origin || allowedOrigins[0];
    const allowedOrigin = allowedOrigins.includes(safeOrigin) ? safeOrigin : allowedOrigins[0];
    return {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
  }

  // --- Address parsing helpers ---
  const STATE_NAME_TO_CODE = {
    alabama: "AL",
    alaska: "AK",
    arizona: "AZ",
    arkansas: "AR",
    california: "CA",
    colorado: "CO",
    connecticut: "CT",
    delaware: "DE",
    florida: "FL",
    georgia: "GA",
    hawaii: "HI",
    idaho: "ID",
    illinois: "IL",
    indiana: "IN",
    iowa: "IA",
    kansas: "KS",
    kentucky: "KY",
    louisiana: "LA",
    maine: "ME",
    maryland: "MD",
    massachusetts: "MA",
    michigan: "MI",
    minnesota: "MN",
    mississippi: "MS",
    missouri: "MO",
    montana: "MT",
    nebraska: "NE",
    nevada: "NV",
    "new hampshire": "NH",
    "new jersey": "NJ",
    "new mexico": "NM",
    "new york": "NY",
    "north carolina": "NC",
    "north dakota": "ND",
    ohio: "OH",
    oklahoma: "OK",
    oregon: "OR",
    pennsylvania: "PA",
    "rhode island": "RI",
    "south carolina": "SC",
    "south dakota": "SD",
    tennessee: "TN",
    texas: "TX",
    utah: "UT",
    vermont: "VT",
    virginia: "VA",
    washington: "WA",
    "west virginia": "WV",
    wisconsin: "WI",
    wyoming: "WY",
    "district of columbia": "DC",
    dc: "DC",
  };

  function normalizeSpaces(str) {
    return String(str || "").replace(/\s+/g, " ").trim();
  }

  function parseUsAddressCsv(addressCsv) {
    const raw = normalizeSpaces(addressCsv);
    if (!raw) return { street: "", city: "", state: "", postalCode: "" };

    // Split by commas (supports: street may contain commas; optional country suffix)
    const parts = raw
      .split(",")
      .map((p) => normalizeSpaces(p))
      .filter(Boolean);

    // Fallback if not enough parts
    if (parts.length < 3) {
      return { street: raw, city: "", state: "", postalCode: "" };
    }

    // Detect whether last chunk is country (no digits) or state+zip (has digits)
    const lastIdx = parts.length - 1;
    const lastHasDigits = /\d/.test(parts[lastIdx]);
    const stateZipIdx = lastHasDigits ? lastIdx : lastIdx - 1;
    const cityIdx = stateZipIdx - 1;

    const street = parts.slice(0, cityIdx).join(", "); // joins any extra commas in street/apt
    const city = parts[cityIdx] || "";
    const stateZip = parts[stateZipIdx] || "";

    // ZIP (5 or ZIP+4)
    const zipMatch = stateZip.match(/\b\d{5}(?:-\d{4})?\b/);
    const postalCode = zipMatch ? zipMatch[0] : "";

    // State: prefer 2-letter code; else map full state name
    let state = "";
    const codeMatch = stateZip.toUpperCase().match(/\b[A-Z]{2}\b/);
    if (codeMatch) {
      state = codeMatch[0];
    } else {
      const cleaned = normalizeSpaces(
        stateZip
          .replace(/\b\d{5}(?:-\d{4})?\b/g, "") // remove zip
          .replace(/[.]/g, "")
      ).toLowerCase();
      // cleaned might be "georgia" or "new york"
      state = STATE_NAME_TO_CODE[cleaned] || "";
    }

    return {
      street: normalizeSpaces(street),
      city: normalizeSpaces(city),
      state: normalizeSpaces(state),
      postalCode: normalizeSpaces(postalCode),
    };
  }

  // Handle preflight OPTIONS request
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders(event.headers?.origin),
      body: "",
    };
  }

  // Only allow POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders(event.headers?.origin),
      body: "Method Not Allowed",
    };
  }

  try {
    const data = JSON.parse(event.body || "{}");

    const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;
    const HUBSPOT_FORM_ID = process.env.HUBSPOT_FORM_ID;

    if (!HUBSPOT_PORTAL_ID || !HUBSPOT_FORM_ID) {
      throw new Error("HubSpot IDs not set in environment variables");
    }

    // Split CSV address: "street, city, state postalCode[, country]"
    const parsed = parseUsAddressCsv(data.address);

    // Send 4 HubSpot fields: address, city, state, zip
    const hubspotPayload = {
      fields: [
        { name: "firstname", value: data.firstname || "" },
        { name: "lastname", value: data.lastname || "" },
        { name: "email", value: data.email || "" },
        { name: "phone", value: data.phone || "" },

        // ✅ Updated address mapping
        { name: "address", value: parsed.street || "" },
        { name: "city", value: parsed.city || "" },
        { name: "state", value: parsed.state || "" },
        { name: "zip", value: parsed.postalCode || "" },

        { name: "utm_source", value: data.utm_source || "" },
        { name: "utm_medium", value: data.utm_medium || "" },
        { name: "utm_campaign", value: data.utm_campaign || "" },
        { name: "utm_term", value: data.utm_term || "" },
        { name: "utm_content", value: data.utm_content || "" },
      ],
      context: { pageUri: data.pageUri || "" },
    };

    const res = await fetch(
      `https://api.hsforms.com/submissions/v3/integration/submit/${HUBSPOT_PORTAL_ID}/${HUBSPOT_FORM_ID}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hubspotPayload),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      return {
        statusCode: 400,
        headers: corsHeaders(event.headers?.origin),
        body: text,
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ success: true }),
    };
  } catch (err) {
    console.error("Submit-lead error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: err.message }),
    };
  }
}
