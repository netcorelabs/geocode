// netlify/functions/upload-deliverables.js
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
"Access-Control-Allow-Methods": "POST, OPTIONS",
"Vary": "Origin",
"Cache-Control": "no-store",
"Content-Type": "application/json",
};
}

  const headers = corsHeaders(event.headers?.origin);

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Method Not Allowed" }) };

const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if (!HS_TOKEN) return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };
  if (!HS_TOKEN) return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing HUBSPOT_PRIVATE_APP_TOKEN" }) };

const FOLDER_ID = String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim();
const FOLDER_PATH = String(process.env.HUBSPOT_FILES_FOLDER_PATH || "").trim();

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
    return fetchJson(`https://api.hubapi.com${path}`, { method: "POST", headers: { ...hsAuth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  async function hsPatch(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "PATCH", headers: { ...hsAuth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  async function hsPut(path) {
    return fetchJson(`https://api.hubapi.com${path}`, { method: "PUT", headers: hsAuth });
  }

  const hsAuth = { Authorization: `Bearer ${HS_TOKEN}` };
  // ---------- deal properties cache ----------
  let _dealPropsCache = globalThis.__HSC_DEAL_PROPS_CACHE || null;
  async function getDealPropertyNames() {
    const now = Date.now();
    if (_dealPropsCache && (now - _dealPropsCache.ts) < 5 * 60 * 1000) return _dealPropsCache.map;

  const hsGet = (path) => fetchJson(`https://api.hubapi.com${path}`, { method: "GET", headers: hsAuth });
  const hsPost = (path, body) => fetchJson(`https://api.hubapi.com${path}`, {
    method: "POST",
    headers: { ...hsAuth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const hsPatch = (path, body) => fetchJson(`https://api.hubapi.com${path}`, {
    method: "PATCH",
    headers: { ...hsAuth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // Cache deal prop existence
  const propExistsCache = new Map();
  async function dealPropExists(name) {
    if (!name) return false;
    if (propExistsCache.has(name)) return propExistsCache.get(name);
    const r = await hsGet(`/crm/v3/properties/deals/${encodeURIComponent(name)}`);
    propExistsCache.set(name, !!r.ok);
    return !!r.ok;
    const r = await hsGet("/crm/v3/properties/deals");
    const arr = Array.isArray(r.json) ? r.json : (Array.isArray(r.json?.results) ? r.json.results : []);
    const map = {};
    for (const p of arr) if (p?.name) map[p.name] = true;
    _dealPropsCache = { ts: now, map };
    globalThis.__HSC_DEAL_PROPS_CACHE = _dealPropsCache;
    return map;
  }
  function onlyExistingProps(propMap, props) {
    const out = {};
    for (const [k, v] of Object.entries(props || {})) if (propMap[k]) out[k] = v;
    return out;
}

  function b64ToBlob(b64, mime) {
    const buf = Buffer.from(String(b64 || ""), "base64");
    return new Blob([buf], { type: mime });
  // ---------- associations cache ----------
  let _assocCache = globalThis.__HSC_ASSOC_CACHE || {};
  async function getAssociationTypeId(fromType, toType) {
    const key = `${fromType}->${toType}`;
    const now = Date.now();
    const cached = _assocCache[key];
    if (cached && (now - cached.ts) < 60 * 60 * 1000) return cached.id;

    const r = await hsGet(`/crm/v4/associations/${encodeURIComponent(fromType)}/${encodeURIComponent(toType)}/labels`);
    const results = Array.isArray(r.json?.results) ? r.json.results : [];
    const pick = results.find(x => String(x?.category || "").toUpperCase() === "HUBSPOT_DEFINED") || results[0];
    const id = pick?.typeId || pick?.associationTypeId || pick?.id;
    if (!id) throw new Error(`Could not resolve associationTypeId for ${fromType} -> ${toType}`);

    _assocCache[key] = { ts: now, id: Number(id) };
    globalThis.__HSC_ASSOC_CACHE = _assocCache;
    return Number(id);
  }
  async function associate(fromType, fromId, toType, toId) {
    const typeId = await getAssociationTypeId(fromType, toType);
    return hsPut(`/crm/v3/objects/${encodeURIComponent(fromType)}/${encodeURIComponent(fromId)}/associations/${encodeURIComponent(toType)}/${encodeURIComponent(toId)}/${typeId}`);
  }

  // ---------- helpers ----------
  function safeStr(v) { return String(v ?? "").trim(); }
  function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function zip3xx(zip) {
    const m = String(zip || "").match(/\b(\d{3})\d{2}\b/);
    return m ? `${m[1]}xx` : "";
}

  async function uploadPrivateFile({ blob, filename }) {
    // HubSpot requires folderId/folderPath as multipart fields (not inside options JSON). :contentReference[oaicite:3]{index=3}
  // tiny CSV parser for one header row + one data row (handles quoted commas)
  function parseCsvLine(line) {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === "," && !inQ) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map(s => String(s ?? "").trim());
  }
  function extractFieldsFromCsv(csvText) {
    const lines = String(csvText || "").split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return {};
    const header = parseCsvLine(lines[0]);
    const row = parseCsvLine(lines[1]);
    const map = {};
    header.forEach((h, idx) => { map[h] = row[idx] ?? ""; });
    return map;
  }

  function computeLeadPrice({ riskScore, upfront, monthly, deviceCount }) {
    const rs = safeNum(riskScore);
    const tierMult = rs >= 70 ? 1.35 : rs >= 40 ? 1.10 : 0.90;
    const selectionValue = (safeNum(upfront) * 0.02) + (safeNum(monthly) * 1.2) + (safeNum(deviceCount) * 1.0);
    const base = 35;
    let price = (base + selectionValue) * tierMult;
    price = Math.round(price / 5) * 5;
    price = Math.max(25, Math.min(250, price));
    return price;
  }

  async function findDealByLeadId(leadId) {
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id", "dealname", "amount", "deliverable_pdf_file_id", "deliverable_csv_file_id", "listing_status"],
      limit: 1,
    });
    return (r.ok && r.json?.results?.[0]) ? r.json.results[0] : null;
  }

  async function readDealById(dealId) {
    const r = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=lead_id,dealname,amount,deliverable_pdf_file_id,deliverable_csv_file_id,listing_status`);
    return (r.ok && r.json?.id) ? r.json : null;
  }

  async function getFirstLineItemIdForDeal(dealId) {
    const r = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items?limit=10`);
    const results = Array.isArray(r.json?.results) ? r.json.results : [];
    const first = results[0]?.id || results[0];
    return first ? String(first) : "";
  }

  async function createOrUpdateLineItemForDeal({ dealId, lineItemName, price }) {
    let lineItemId = await getFirstLineItemIdForDeal(dealId);

    if (!lineItemId) {
      const created = await hsPost("/crm/v3/objects/line_items", {
        properties: { name: lineItemName, quantity: "1", price: String(price) },
      });
      if (!created.ok || !created.json?.id) throw new Error("Line item create failed: " + (created.text || "unknown"));
      lineItemId = String(created.json.id);

      const assoc = await associate("line_items", lineItemId, "deals", dealId);
      if (!assoc.ok) throw new Error("Line item association failed: " + (assoc.text || "unknown"));
    } else {
      await hsPatch(`/crm/v3/objects/line_items/${encodeURIComponent(lineItemId)}`, {
        properties: { name: lineItemName, quantity: "1", price: String(price) },
      });
    }
    return lineItemId;
  }

  async function uploadFileToHubSpot({ blob, filename }) {
    const qs = new URLSearchParams();
    if (FOLDER_ID) qs.set("folderId", FOLDER_ID);
    else if (FOLDER_PATH) qs.set("folderPath", FOLDER_PATH);

    const url = "https://api.hubapi.com/files/v3/files" + (qs.toString() ? `?${qs}` : "");

const form = new FormData();

    // IMPORTANT: HubSpot is picky — we send folderId/folderPath in multiple ways for robustness.
    if (FOLDER_ID) form.append("folderId", FOLDER_ID);
    if (FOLDER_PATH) form.append("folderPath", FOLDER_PATH);

form.append("options", JSON.stringify({
access: "PRIVATE",
overwrite: false,
duplicateValidationStrategy: "NONE",
}));
    if (FOLDER_ID) form.append("folderId", FOLDER_ID);
    else if (FOLDER_PATH) form.append("folderPath", FOLDER_PATH);

    form.append("fileName", filename);
form.append("file", blob, filename);

    const res = await fetch("https://api.hubapi.com/files/v3/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${HS_TOKEN}` },
      body: form,
    });

    const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${HS_TOKEN}` }, body: form });
const text = await res.text().catch(() => "");
let json = null;
try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
    return { ok: res.ok, status: res.status, json, text, url };
}

  // Association type id for Note -> Deal is 214 (HubSpot-defined). :contentReference[oaicite:4]{index=4}
  const NOTE_TO_DEAL_TYPE_ID = 214;

  async function createNoteWithAttachment({ dealId, fileId, bodyText }) {
    const r = await hsPost("/crm/v3/objects/notes", {
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_note_body: String(bodyText || "Attached file for deal"),
        // For multiple files, HubSpot supports semicolon-separated ids; we use single per note here.
        hs_attachment_ids: String(fileId),
      },
      associations: [
        {
          to: { id: String(dealId) },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_DEAL_TYPE_ID }]
        }
      ]
    });
    if (!r.ok || !r.json?.id) {
      throw new Error("Note create failed: " + (r.text || ""));
    }
    return String(r.json.id);
  function b64ToBlob(b64, mime) {
    const buf = Buffer.from(String(b64 || ""), "base64");
    return new Blob([buf], { type: mime });
}

try {
const body = JSON.parse(event.body || "{}");
    const lead_id = String(body.lead_id || "").trim();
    const deal_id = String(body.deal_id || "").trim();
    const pdf_base64 = String(body.pdf_base64 || "").trim();
    const lead_id = safeStr(body.lead_id);
    const deal_id_in = safeStr(body.deal_id);
    const pdf_base64 = safeStr(body.pdf_base64);
const csv_text = String(body.csv_text || "");
    const csv_base64 = safeStr(body.csv_base64);

    if (!deal_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing deal_id" }) };
    if (!lead_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing lead_id" }) };
    if (!pdf_base64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing pdf_base64" }) };
    if (!csv_text) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing csv_text" }) };
    if (!lead_id && !deal_id_in) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing lead_id or deal_id" }) };
    if (!pdf_base64) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing pdf_base64" }) };
    if (!csv_text && !csv_base64) return { statusCode: 400, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Missing csv_text or csv_base64" }) };

    // Ensure deal exists
    const dealCheck = await hsGet(`/crm/v3/objects/deals/${encodeURIComponent(deal_id)}?properties=dealname,lead_id`);
    if (!dealCheck.ok) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Deal not found", deal_id, detail: dealCheck.text }) };
    }
    // Resolve deal
    let deal = null;
    if (deal_id_in) deal = await readDealById(deal_id_in);
    if (!deal && lead_id) deal = await findDealByLeadId(lead_id);

    // Optional: mark "processing"
    const statusProps = {};
    if (await dealPropExists("lead_status")) statusProps.lead_status = "Deliverables Processing";
    if (await dealPropExists("listing_status")) statusProps.listing_status = "Deliverables Processing";
    if (Object.keys(statusProps).length) {
      await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(deal_id)}`, { properties: statusProps });
    }
    if (!deal?.id) return { statusCode: 404, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal not found", lead_id, deal_id: deal_id_in }) };

    const pdfFilename = `home-secure-report-${deal_id}.pdf`;
    const csvFilename = `home-secure-lead-${deal_id}.csv`;
    const dealId = String(deal.id);
    const leadId = safeStr(deal.properties?.lead_id || lead_id);

    // Upload files
const pdfBlob = b64ToBlob(pdf_base64, "application/pdf");
    const csvBlob = new Blob([Buffer.from(csv_text, "utf8")], { type: "text/csv" });
    const csvBlob = csv_base64 ? b64ToBlob(csv_base64, "text/csv") : new Blob([csv_text], { type: "text/csv" });

    const pdfFilename = `home-secure-report-${dealId}.pdf`;
    const csvFilename = `home-secure-lead-${dealId}.csv`;

    const pdfUp = await uploadPrivateFile({ blob: pdfBlob, filename: pdfFilename });
    const pdfUp = await uploadFileToHubSpot({ blob: pdfBlob, filename: pdfFilename });
if (!pdfUp.ok || !pdfUp.json?.id) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "PDF upload failed", detail: pdfUp.text, folderId: FOLDER_ID, folderPath: FOLDER_PATH }) };
      return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "PDF upload failed", detail: pdfUp.text, upload_url: pdfUp.url, env_seen: { HUBSPOT_FILES_FOLDER_ID: FOLDER_ID, HUBSPOT_FILES_FOLDER_PATH: FOLDER_PATH } }) };
}

    const csvUp = await uploadPrivateFile({ blob: csvBlob, filename: csvFilename });
    const csvUp = await uploadFileToHubSpot({ blob: csvBlob, filename: csvFilename });
if (!csvUp.ok || !csvUp.json?.id) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "CSV upload failed", detail: csvUp.text, folderId: FOLDER_ID, folderPath: FOLDER_PATH }) };
      return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "CSV upload failed", detail: csvUp.text, upload_url: csvUp.url }) };
}

const pdfFileId = String(pdfUp.json.id);
const csvFileId = String(csvUp.json.id);

    // Create notes (attachments) on the deal timeline
    const notePdfId = await createNoteWithAttachment({
      dealId: deal_id,
      fileId: pdfFileId,
      bodyText: `Deliverable: Security Report PDF (lead_id=${lead_id})`
    });
    // Create NOTE with attachments
    const nowMs = Date.now();
    const noteBody =
      `Deliverables uploaded for exclusive lead.\n` +
      `Deal: ${dealId}\nLead: ${leadId}\n` +
      `PDF fileId: ${pdfFileId}\nCSV fileId: ${csvFileId}\n` +
      `Status: Deliverables Ready`;

    const noteCsvId = await createNoteWithAttachment({
      dealId: deal_id,
      fileId: csvFileId,
      bodyText: `Deliverable: Lead CSV (lead_id=${lead_id})`
    const noteCreate = await hsPost("/crm/v3/objects/notes", {
      properties: {
        hs_timestamp: String(nowMs),
        hs_note_body: noteBody,
        // HubSpot expects a JSON string array here:
        hs_attachment_ids: JSON.stringify([pdfFileId, csvFileId]),
      },
});

    // Store ids on the deal if these props exist (optional but strongly recommended)
    const patch = {};
    if (await dealPropExists("deliverable_pdf_file_id")) patch.deliverable_pdf_file_id = pdfFileId;
    if (await dealPropExists("deliverable_csv_file_id")) patch.deliverable_csv_file_id = csvFileId;
    if (await dealPropExists("deliverable_pdf_note_id")) patch.deliverable_pdf_note_id = notePdfId;
    if (await dealPropExists("deliverable_csv_note_id")) patch.deliverable_csv_note_id = noteCsvId;
    if (!noteCreate.ok || !noteCreate.json?.id) {
      return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Note create failed", detail: noteCreate.text }) };
    }

    const noteId = String(noteCreate.json.id);

    const assocNote = await associate("notes", noteId, "deals", dealId);
    if (!assocNote.ok) {
      return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Note association failed", detail: assocNote.text }) };
    }

    // Price update from CSV (risk score tier pricing)
    const csvFields = extractFieldsFromCsv(csv_text || "");
    const riskScore = safeNum(csvFields.hsc_risk_score);
    const upfront = safeNum(csvFields.hsc_upfront);
    const monthly = safeNum(csvFields.hsc_monthly);
    const devicesStr = String(csvFields.hsc_devices || "");
    const deviceCount = (devicesStr.match(/\bx(\d+)\b/g) || [])
      .map(m => Number(m.replace(/[^\d]/g, "")))
      .reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

    // Ready but unpaid (you can rename statuses however you like)
    if (await dealPropExists("lead_status")) patch.lead_status = "Deliverables Ready (Unpaid)";
    if (await dealPropExists("listing_status")) patch.listing_status = "Unpaid";
    const leadPrice = computeLeadPrice({ riskScore, upfront, monthly, deviceCount });

    if (Object.keys(patch).length) {
      const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(deal_id)}`, { properties: patch });
    // Update deal properties (only if they exist)
    const dealPropsMap = await getDealPropertyNames();
    const patchProps = onlyExistingProps(dealPropsMap, {
      deliverable_pdf_file_id: pdfFileId,
      deliverable_csv_file_id: csvFileId,
      listing_status: "Deliverables Ready",
      amount: String(leadPrice),
    });

    if (Object.keys(patchProps).length) {
      const patched = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: patchProps });
if (!patched.ok) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Deal update failed (deliverable ids)", detail: patched.text }) };
        return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: "Deal update failed", detail: patched.text }) };
}
}

    // Ensure line item exists + matches deal amount
    const city = safeStr(csvFields.city);
    const state = safeStr(csvFields.state);
    const zip = safeStr(csvFields.zip);
    const redacted = (city || state) ? `${[city, state].filter(Boolean).join(", ")} ${zip3xx(zip)}`.trim() : "Unknown";
    const lineItemName = `Exclusive Lead — ${redacted}`.trim();

    const lineItemId = await createOrUpdateLineItemForDeal({ dealId, lineItemName, price: leadPrice });

    // Return
return {
statusCode: 200,
      headers,
      headers: corsHeaders(event.headers?.origin),
body: JSON.stringify({
ok: true,
        lead_id,
        deal_id,
        lead_id: leadId,
        deal_id: dealId,
        line_item_id: lineItemId,
        lead_price: leadPrice,
pdf_file_id: pdfFileId,
csv_file_id: csvFileId,
        pdf_note_id: notePdfId,
        csv_note_id: noteCsvId,
        folderId: FOLDER_ID || null,
        folderPath: FOLDER_PATH || null,
      })
        note_id: noteId,
        folder: { folderId: FOLDER_ID || null, folderPath: FOLDER_PATH || null },
      }),
};
} catch (err) {
console.error("upload-deliverables error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err?.message || err) }) };
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error: String(err?.message || err) }) };
}
}
