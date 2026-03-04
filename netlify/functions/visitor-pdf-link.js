// netlify/functions/visitor-pdf-link.js
// Returns visitor-ready PDF/CSV links for a deal.
// Prefers stored Deal properties deliverable_pdf_url / deliverable_csv_url.
// Falls back to file hosting URL (PUBLIC*) or signed-url (PRIVATE).
// Hardened:
//   ✅ Find deal by lead_id property (exact) first, fallback to dealname
//   ✅ If PDF URL exists but CSV URL missing, still try to resolve CSV
//   ✅ Cache PUBLIC hosting URLs back onto the deal (safe + fast)

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
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Vary": "Origin",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    };
  }

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  }

  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) {
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }),
    };
  }

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };

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

  // Patch deal but ignore missing properties (if a portal doesn’t have them)
  async function patchDealWithFallback(dealId, properties) {
    const attempt = async (props) =>
      fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
        method: "PATCH",
        headers: { ...hsAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: props }),
      });

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
    // 1) Best: exact match on lead_id property
    const exact = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id", "deliverable_pdf_file_id", "deliverable_csv_file_id", "deliverable_pdf_url", "deliverable_csv_url"],
      sorts: ["-hs_lastmodifieddate"],
      limit: 1,
    });

    if (exact.ok && exact.json?.results?.[0]) return exact.json.results[0];

    // 2) Fallback: dealname contains leadId (older deals / legacy naming)
    const contains = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "dealname", operator: "CONTAINS_TOKEN", value: leadId }] }],
      properties: ["lead_id", "deliverable_pdf_file_id", "deliverable_csv_file_id", "deliverable_pdf_url", "deliverable_csv_url"],
      sorts: ["-hs_lastmodifieddate"],
      limit: 1,
    });

    return (contains.ok && contains.json?.results?.[0]) ? contains.json.results[0] : null;
  }

  async function readDealById(dealId) {
    const r = await hsGet(
      `/crm/v3/objects/deals/${encodeURIComponent(dealId)}` +
      `?properties=lead_id,deliverable_pdf_file_id,deliverable_csv_file_id,deliverable_pdf_url,deliverable_csv_url`
    );
    return (r.ok && r.json?.id) ? r.json : null;
  }

  async function readFile(fileId) {
    const r = await hsGet(`/files/v3/files/${encodeURIComponent(fileId)}`);
    return (r.ok && r.json?.id) ? r.json : null;
  }

  async function createSignedUrl(fileId) {
    const r = await hsGet(`/files/v3/files/${encodeURIComponent(fileId)}/signed-url`);
    const url = String(r.json?.url || "").trim();
    return (r.ok && url) ? { ok: true, url } : { ok: false, status: r.status, text: r.text || "Failed to create signed URL" };
  }

  function readInputs() {
    let lead_id = "";
    let deal_id = "";
    if (event.httpMethod === "GET") {
      const qs = event.queryStringParameters || {};
      lead_id = String(qs.lead_id || "").trim();
      deal_id = String(qs.deal_id || "").trim();
      return { lead_id, deal_id };
    }
    try {
      const body = JSON.parse(event.body || "{}");
      lead_id = String(body.lead_id || "").trim();
      deal_id = String(body.deal_id || "").trim();
    } catch {}
    return { lead_id, deal_id };
  }

  try {
    const { lead_id, deal_id } = readInputs();
    if (!deal_id && !lead_id) {
      return {
        statusCode: 400,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Missing deal_id or lead_id" }),
      };
    }

    let deal = null;
    if (deal_id) deal = await readDealById(deal_id);
    if (!deal && lead_id) deal = await findDealByLeadId(lead_id);

    if (!deal?.id) {
      return {
        statusCode: 404,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Deal not found", deal_id, lead_id }),
      };
    }

    const dealId = String(deal.id);
    const props = deal.properties || {};

    let pdfUrlStored = String(props.deliverable_pdf_url || "").trim();
    let csvUrlStored = String(props.deliverable_csv_url || "").trim();

    const pdfFileId = String(props.deliverable_pdf_file_id || "").trim();
    const csvFileId = String(props.deliverable_csv_file_id || "").trim();

    // If we already have both URLs, return immediately
    if (pdfUrlStored && csvUrlStored) {
      return {
        statusCode: 200,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          ok: true,
          deal_id: dealId,
          lead_id: String(props.lead_id || lead_id || "").trim(),
          pdf_file_id: pdfFileId || null,
          pdf_url: pdfUrlStored,
          csv_file_id: csvFileId || null,
          csv_url: csvUrlStored,
          source: "deal_properties",
        }),
      };
    }

    // If we have a stored PDF URL, still try to resolve CSV if missing
    // (prevents the CSV button from staying disabled forever)
    if (pdfUrlStored && !csvUrlStored && csvFileId) {
      // try file lookup for CSV
      async function bestUrl(fileId) {
        const file = await readFile(fileId);
        const access = String(file?.access || "").toUpperCase();
        const hosting = String(file?.defaultHostingUrl || file?.url || "").trim();

        if (hosting && access.startsWith("PUBLIC")) return { ok: true, url: hosting, mode: "hosting", public: true };
        const signed = await createSignedUrl(fileId);
        if (signed.ok) return { ok: true, url: signed.url, mode: "signed", public: false };
        return { ok: false, url: "", mode: "none", detail: signed.text || "No URL available" };
      }

      const csvBest = await bestUrl(csvFileId);
      if (csvBest.ok) {
        csvUrlStored = csvBest.url;

        // Cache only PUBLIC hosting URLs to avoid persisting expiring signed URLs
        if (csvBest.public) {
          await patchDealWithFallback(dealId, { deliverable_csv_url: csvUrlStored });
        }
      }

      return {
        statusCode: 200,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({
          ok: true,
          deal_id: dealId,
          lead_id: String(props.lead_id || lead_id || "").trim(),
          pdf_file_id: pdfFileId || null,
          pdf_url: pdfUrlStored,
          csv_file_id: csvFileId || null,
          csv_url: csvUrlStored || null,
          csv_url_mode: csvBest?.mode || null,
          source: "pdf_property_csv_lookup",
        }),
      };
    }

    // If PDF URL not stored, but fileId missing => not ready (polling state)
    if (!pdfUrlStored && !pdfFileId) {
      return {
        statusCode: 409,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "PDF not ready yet", deal_id: dealId, lead_id: String(props.lead_id || lead_id || "").trim() }),
      };
    }

    async function bestUrl(fileId) {
      const file = await readFile(fileId);
      const access = String(file?.access || "").toUpperCase();
      const hosting = String(file?.defaultHostingUrl || file?.url || "").trim();

      if (hosting && access.startsWith("PUBLIC")) return { ok: true, url: hosting, mode: "hosting", public: true };

      const signed = await createSignedUrl(fileId);
      if (signed.ok) return { ok: true, url: signed.url, mode: "signed", public: false };

      return { ok: false, url: "", mode: "none", detail: signed.text || "No URL available" };
    }

    // Resolve PDF
    let pdfMode = null;
    if (!pdfUrlStored && pdfFileId) {
      const pdfBest = await bestUrl(pdfFileId);
      if (!pdfBest.ok) {
        return {
          statusCode: 500,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({ error: "Failed to create visitor URL", detail: pdfBest.detail || "unknown", deal_id: dealId }),
        };
      }
      pdfUrlStored = pdfBest.url;
      pdfMode = pdfBest.mode;

      // Cache only PUBLIC hosting URLs (avoid saving expiring signed URLs)
      if (pdfBest.public) {
        await patchDealWithFallback(dealId, { deliverable_pdf_url: pdfUrlStored });
      }
    }

    // Resolve CSV (optional)
    let csv_url = csvUrlStored || "";
    let csvMode = null;

    if (!csv_url && csvFileId) {
      const csvBest = await bestUrl(csvFileId);
      if (csvBest.ok) {
        csv_url = csvBest.url;
        csvMode = csvBest.mode;
        if (csvBest.public) {
          await patchDealWithFallback(dealId, { deliverable_csv_url: csv_url });
        }
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        deal_id: dealId,
        lead_id: String(props.lead_id || lead_id || "").trim(),
        pdf_file_id: pdfFileId || null,
        pdf_url: pdfUrlStored,
        pdf_url_mode: pdfMode || (pdfUrlStored ? "deal_properties" : null),
        csv_file_id: csvFileId || null,
        csv_url: csv_url || null,
        csv_url_mode: csvMode || (csv_url ? "deal_properties" : null),
        source: pdfUrlStored && csv_url ? "mixed_cached" : "file_lookup",
      }),
    };
  } catch (err) {
    console.error("visitor-pdf-link error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: String(err?.message || err) }),
    };
  }
}
