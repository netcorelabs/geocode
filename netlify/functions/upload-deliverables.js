// netlify/functions/upload-deliverables.js
import { Blob } from "buffer";

export async function handler(event) {
  const allowedOrigins = [
    "https://www.homesecurecalculator.com",
    "https://homesecurecalculator.com",
    "https://www.netcoreleads.com",
    "https://netcoreleads.com",
    "https://api.netcoreleads.com",
    "https://hubspotgate.netlify.app",
  ];

  function corsHeaders(originRaw) {
    const origin = (originRaw || "").trim();
    const allowOrigin = origin
      ? (allowedOrigins.includes(origin) ? origin : allowedOrigins[0])
      : "*";

    return {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

  const hsAuthHeadersJson = {
    Authorization: `Bearer ${HS_TOKEN}`,
    "Content-Type": "application/json",
  };

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

  async function hsPost(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "POST",
      headers: hsAuthHeadersJson,
      body: JSON.stringify(body),
    });
  }

  async function hsPatch(path, body) {
    return fetchJson(`https://api.hubapi.com${path}`, {
      method: "PATCH",
      headers: hsAuthHeadersJson,
      body: JSON.stringify(body),
    });
  }

  async function findDealIdByLeadId(leadId) {
    const r = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "lead_id", operator: "EQ", value: leadId }] }],
      properties: ["lead_id"],
      limit: 1,
    });
    const id = r.json?.results?.[0]?.id;
    return id ? String(id) : "";
  }

  function cleanBase64(b64) {
    return String(b64 || "")
      .replace(/^data:.*?;base64,/i, "")
      .replace(/\s+/g, "")
      .trim();
  }

  function b64ToUint8(b64) {
    const cleaned = cleanBase64(b64);
    return Uint8Array.from(Buffer.from(cleaned, "base64"));
  }

  async function uploadPrivateFile({ blob, filename }) {
    // HubSpot Files v3: multipart with "options" + "file"
    const form = new FormData();
    form.append("options", JSON.stringify({ access: "PRIVATE", overwrite: false }));
    form.append("file", blob, filename);

    const res = await fetch("https://api.hubapi.com/files/v3/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${HS_TOKEN}` },
      body: form,
    });

    const text = await res.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const lead_id = String(body.lead_id || "").trim();
    let deal_id = String(body.deal_id || "").trim();

    const pdf_base64 = String(body.pdf_base64 || "").trim();
    const csv_text = String(body.csv_text || "");

    if (!pdf_base64) {
      return {
        statusCode: 400,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Missing pdf_base64" }),
      };
    }
    if (!csv_text) {
      return {
        statusCode: 400,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Missing csv_text" }),
      };
    }

    // Prefer deal_id; fall back to lead_id search only if needed
    if (!deal_id) {
      if (!lead_id) {
        return {
          statusCode: 400,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({ error: "Missing deal_id (and lead_id fallback missing)" }),
        };
      }
      deal_id = await findDealIdByLeadId(lead_id);
      if (!deal_id) {
        return {
          statusCode: 404,
          headers: corsHeaders(event.headers?.origin),
          body: JSON.stringify({ error: "Deal not found for lead_id", lead_id }),
        };
      }
    }

    // Upload PDF (PRIVATE)
    const pdfBlob = new Blob([b64ToUint8(pdf_base64)], { type: "application/pdf" });
    const pdfUp = await uploadPrivateFile({
      blob: pdfBlob,
      filename: `home-secure-report-${deal_id}.pdf`,
    });

    if (!pdfUp.ok || !pdfUp.json?.id) {
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "PDF upload failed", detail: pdfUp.text }),
      };
    }

    // Upload CSV (PRIVATE)
    const csvBlob = new Blob([csv_text], { type: "text/csv" });
    const csvUp = await uploadPrivateFile({
      blob: csvBlob,
      filename: `home-secure-lead-${deal_id}.csv`,
    });

    if (!csvUp.ok || !csvUp.json?.id) {
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "CSV upload failed", detail: csvUp.text }),
      };
    }

    const pdfFileId = String(pdfUp.json.id);
    const csvFileId = String(csvUp.json.id);

    // Write file IDs onto the Deal
    const patch = await hsPatch(`/crm/v3/objects/deals/${encodeURIComponent(deal_id)}`, {
      properties: {
        deliverable_pdf_file_id: pdfFileId,
        deliverable_csv_file_id: csvFileId,
        ...(lead_id ? { lead_id } : {}),
      },
    });

    if (!patch.ok) {
      return {
        statusCode: 500,
        headers: corsHeaders(event.headers?.origin),
        body: JSON.stringify({ error: "Deal update failed (file ids)", detail: patch.text }),
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({
        ok: true,
        lead_id: lead_id || "",
        deal_id,
        pdf_file_id: pdfFileId,
        csv_file_id: csvFileId,
      }),
    };
  } catch (err) {
    console.error("upload-deliverables error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers?.origin),
      body: JSON.stringify({ error: String(err?.message || err) }),
    };
  }
}
