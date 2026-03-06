// /netlify/functions/_secure-deliverables.js

const crypto = require("crypto");

const ALLOWED_ORIGINS = [
  "https://www.homesecurecalculator.com",
  "https://homesecurecalculator.com",
  "http://www.homesecurecalculator.com",
  "http://homesecurecalculator.com",
  "https://www.netcoreleads.com",
  "https://netcoreleads.com",
  "https://api.netcoreleads.com",
  "https://hubspotgate.netlify.app",
];

function corsHeaders(originRaw, contentType = "application/json") {
  const origin = String(originRaw || "").trim();
  const allowOrigin = origin
    ? (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0])
    : "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Vary": "Origin",
    "Cache-Control": "no-store",
    "Content-Type": contentType,
  };
}

function readSecret() {
  return String(process.env.DOWNLOAD_TOKEN_SECRET || "").trim();
}

function readTtlHours() {
  const raw = Number(process.env.DOWNLOAD_TOKEN_TTL_HOURS || 168);
  return Number.isFinite(raw) && raw > 0 ? raw : 168;
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input) {
  const normalized = String(input || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = normalized + (pad ? "=".repeat(4 - pad) : "");
  return Buffer.from(padded, "base64").toString("utf8");
}

function hmacSign(data, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function createDownloadToken(payload) {
  const secret = readSecret();
  if (!secret) throw new Error("Missing DOWNLOAD_TOKEN_SECRET");

  const now = Date.now();
  const ttlMs = readTtlHours() * 60 * 60 * 1000;

  const finalPayload = {
    lead_id: String(payload.lead_id || "").trim(),
    deal_id: String(payload.deal_id || "").trim(),
    type: String(payload.type || "report").trim().toLowerCase(),
    email: String(payload.email || "").trim(),
    iat: Number(payload.iat || now),
    exp: Number(payload.exp || (now + ttlMs)),
    v: 1,
  };

  const encoded = base64UrlEncode(JSON.stringify(finalPayload));
  const sig = hmacSign(encoded, secret);
  return `${encoded}.${sig}`;
}

function verifyDownloadToken(token) {
  const secret = readSecret();
  if (!secret) return { ok: false, error: "Missing DOWNLOAD_TOKEN_SECRET" };

  const raw = String(token || "").trim();
  if (!raw || raw === "invalid") {
    return { ok: false, error: "Missing token" };
  }

  const parts = raw.split(".");
  if (parts.length !== 2) {
    return { ok: false, error: "Malformed token" };
  }

  const [encoded, sig] = parts;
  const expected = hmacSign(encoded, secret);

  if (sig !== expected) {
    return { ok: false, error: "Token signature invalid" };
  }

  const payload = safeJsonParse(base64UrlDecode(encoded));
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Token payload invalid" };
  }

  const now = Date.now();
  const exp = Number(payload.exp || 0);
  const iat = Number(payload.iat || 0);

  if (!exp || now > exp) {
    return { ok: false, error: "Token expired" };
  }

  if (!iat || iat > now + 5 * 60 * 1000) {
    return { ok: false, error: "Token issue time invalid" };
  }

  const clean = {
    lead_id: String(payload.lead_id || "").trim(),
    deal_id: String(payload.deal_id || "").trim(),
    type: String(payload.type || "report").trim().toLowerCase(),
    email: String(payload.email || "").trim(),
    iat,
    exp,
    v: Number(payload.v || 1),
  };

  if (!clean.deal_id && !clean.lead_id) {
    return { ok: false, error: "Token missing lead_id/deal_id" };
  }

  if (!["pdf", "csv", "report"].includes(clean.type)) {
    return { ok: false, error: "Token type invalid" };
  }

  return { ok: true, payload: clean };
}

async function readText(res) {
  try { return await res.text(); } catch { return ""; }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await readText(res);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

function getHsToken() {
  return String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
}

function hsHeaders() {
  const token = getHsToken();
  return { Authorization: `Bearer ${token}` };
}

async function hsGet(path) {
  return fetchJson(`https://api.hubapi.com${path}`, {
    method: "GET",
    headers: hsHeaders(),
  });
}

async function hsPost(path, body) {
  return fetchJson(`https://api.hubapi.com${path}`, {
    method: "POST",
    headers: {
      ...hsHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function patchDealWithFallback(dealId, properties) {
  const attempt = async (props) =>
    fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      method: "PATCH",
      headers: {
        ...hsHeaders(),
        "Content-Type": "application/json",
      },
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

  if (!badProps.size) return r;

  const filtered = Object.fromEntries(
    Object.entries(properties).filter(([k]) => !badProps.has(k))
  );

  if (!Object.keys(filtered).length) return r;
  return attempt(filtered);
}

async function findDealByLeadId(leadId) {
  const exact = await hsPost("/crm/v3/objects/deals/search", {
    filterGroups: [{
      filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }]
    }],
    properties: [
      "lead_id",
      "dealname",
      "deliverable_pdf_file_id",
      "deliverable_csv_file_id",
      "deliverable_pdf_url",
      "deliverable_csv_url",
    ],
    sorts: ["-hs_lastmodifieddate"],
    limit: 1,
  });

  if (exact.ok && exact.json?.results?.[0]) return exact.json.results[0];

  const contains = await hsPost("/crm/v3/objects/deals/search", {
    filterGroups: [{
      filters: [{ propertyName: "dealname", operator: "CONTAINS_TOKEN", value: leadId }]
    }],
    properties: [
      "lead_id",
      "dealname",
      "deliverable_pdf_file_id",
      "deliverable_csv_file_id",
      "deliverable_pdf_url",
      "deliverable_csv_url",
    ],
    sorts: ["-hs_lastmodifieddate"],
    limit: 1,
  });

  return (contains.ok && contains.json?.results?.[0]) ? contains.json.results[0] : null;
}

async function readDealById(dealId) {
  const r = await hsGet(
    `/crm/v3/objects/deals/${encodeURIComponent(dealId)}` +
    `?properties=lead_id,dealname,deliverable_pdf_file_id,deliverable_csv_file_id,deliverable_pdf_url,deliverable_csv_url`
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
  return (r.ok && url)
    ? { ok: true, url }
    : { ok: false, status: r.status, text: r.text || "Failed to create signed URL" };
}

async function bestUrl(fileId) {
  const file = await readFile(fileId);
  const access = String(file?.access || "").toUpperCase();
  const hosting = String(file?.defaultHostingUrl || file?.url || "").trim();

  if (hosting && access.startsWith("PUBLIC")) {
    return { ok: true, url: hosting, mode: "hosting", public: true };
  }

  const signed = await createSignedUrl(fileId);
  if (signed.ok) {
    return { ok: true, url: signed.url, mode: "signed", public: false };
  }

  return {
    ok: false,
    url: "",
    mode: "none",
    detail: signed.text || "No URL available",
  };
}

async function resolveDeliverablesByIds({ lead_id, deal_id }) {
  const hsToken = getHsToken();
  if (!hsToken) {
    return { ok: false, statusCode: 500, error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" };
  }

  let deal = null;
  if (deal_id) deal = await readDealById(deal_id);
  if (!deal && lead_id) deal = await findDealByLeadId(lead_id);

  if (!deal?.id) {
    return { ok: false, statusCode: 404, error: "Deal not found", lead_id, deal_id };
  }

  const dealId = String(deal.id);
  const props = deal.properties || {};

  let pdfUrlStored = String(props.deliverable_pdf_url || "").trim();
  let csvUrlStored = String(props.deliverable_csv_url || "").trim();

  const pdfFileId = String(props.deliverable_pdf_file_id || "").trim();
  const csvFileId = String(props.deliverable_csv_file_id || "").trim();

  if (!pdfUrlStored && !pdfFileId) {
    return {
      ok: false,
      statusCode: 409,
      error: "PDF not ready yet",
      deal_id: dealId,
      lead_id: String(props.lead_id || lead_id || "").trim(),
    };
  }

  let pdfMode = null;
  if (!pdfUrlStored && pdfFileId) {
    const pdfBest = await bestUrl(pdfFileId);
    if (!pdfBest.ok) {
      return {
        ok: false,
        statusCode: 500,
        error: "Failed to create PDF URL",
        detail: pdfBest.detail || "unknown",
        deal_id: dealId,
      };
    }
    pdfUrlStored = pdfBest.url;
    pdfMode = pdfBest.mode;

    if (pdfBest.public) {
      await patchDealWithFallback(dealId, { deliverable_pdf_url: pdfUrlStored });
    }
  }

  let csvMode = null;
  if (!csvUrlStored && csvFileId) {
    const csvBest = await bestUrl(csvFileId);
    if (csvBest.ok) {
      csvUrlStored = csvBest.url;
      csvMode = csvBest.mode;

      if (csvBest.public) {
        await patchDealWithFallback(dealId, { deliverable_csv_url: csvUrlStored });
      }
    }
  }

  return {
    ok: true,
    deal_id: dealId,
    lead_id: String(props.lead_id || lead_id || "").trim(),
    pdf_file_id: pdfFileId || null,
    pdf_url: pdfUrlStored || null,
    pdf_url_mode: pdfMode || (pdfUrlStored ? "deal_properties" : null),
    csv_file_id: csvFileId || null,
    csv_url: csvUrlStored || null,
    csv_url_mode: csvMode || (csvUrlStored ? "deal_properties" : null),
  };
}

function getTokenFromEvent(event) {
  if (event.httpMethod === "GET") {
    return String(event.queryStringParameters?.token || "").trim();
  }
  try {
    const body = JSON.parse(event.body || "{}");
    return String(body.token || "").trim();
  } catch {
    return "";
  }
}

function jsonResponse(origin, statusCode, bodyObj) {
  return {
    statusCode,
    headers: corsHeaders(origin),
    body: JSON.stringify(bodyObj),
  };
}

function redirectResponse(origin, url) {
  return {
    statusCode: 302,
    headers: {
      ...corsHeaders(origin, "text/plain"),
      Location: url,
    },
    body: "",
  };
}

module.exports = {
  corsHeaders,
  createDownloadToken,
  verifyDownloadToken,
  resolveDeliverablesByIds,
  getTokenFromEvent,
  jsonResponse,
  redirectResponse,
  readTtlHours,
};
