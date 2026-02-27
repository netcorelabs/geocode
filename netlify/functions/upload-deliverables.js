// netlify/functions/upload-deliverables.js
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

if (event.httpMethod === "OPTIONS") {
return { statusCode: 204, headers: corsHeaders(event.headers?.origin), body: "" };
}

if (event.httpMethod !== "POST") {
return { statusCode: 405, headers: corsHeaders(event.headers?.origin), body: JSON.stringify({ error:"Method not allowed" }) };
}

try {

const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
if (!HS_TOKEN) throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");

const hsAuth = { Authorization:`Bearer ${HS_TOKEN}` };

const rawFolderId = String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim();
const rawFolderPath = String(process.env.HUBSPOT_FILES_FOLDER_PATH || "").trim();

if (!rawFolderId && !rawFolderPath)
throw new Error("Missing folder config");

const body = JSON.parse(event.body || "{}");

const { lead_id, deal_id, pdf_base64, csv_text, payload } = body;

if (!lead_id || !deal_id) throw new Error("Missing lead_id or deal_id");
if (!pdf_base64) throw new Error("Missing pdf_base64");
if (!csv_text) throw new Error("Missing csv_text");

const folderId = rawFolderId || null;
const folderPath = rawFolderPath || null;

async function fetchJson(url, opts){
const res = await fetch(url, opts);
const text = await res.text().catch(()=>null);
let json=null;
try{ json=text?JSON.parse(text):null }catch{}
return { ok:res.ok,status:res.status,json,text };
}

async function patchDealWithFallback(dealId, properties) {
return fetchJson(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}`,{
method:"PATCH",
headers:{ ...hsAuth,"Content-Type":"application/json" },
body: JSON.stringify({ properties })
});
}

function payloadToCsvDump(obj,prefix=""){
let rows=[];
for(const k in obj){
const val=obj[k];
const key=prefix?`${prefix}.${k}`:k;
if(typeof val==="object" && val!==null) rows=rows.concat(payloadToCsvDump(val,key));
else rows.push(`${key},${String(val).replace(/,/g," ")}`);
}
return rows.join("\n");
}

function stripDataUrl(b64){
const s=String(b64||"");
const i=s.indexOf("base64,");
return i>-1?s.slice(i+7):s;
}

async function uploadFileToHubSpot({ bytes, filename, mimeType }) {
const form=new FormData();
form.append("file", new Blob([bytes],{type:mimeType}), filename);
form.append("options", JSON.stringify({ access:"PRIVATE" }));
if(folderId) form.append("folderId",String(folderId));
else form.append("folderPath",String(folderPath));

const res=await fetchJson("https://api.hubapi.com/files/v3/files",{ method:"POST", headers:{...hsAuth}, body:form });
if(!res.ok) throw new Error("Upload failed");
return { fileId:res.json.id };
}

async function createEngagementNoteWithAttachments({ dealId, leadId, fileIds }) {
const now=Date.now();
const body={
engagement:{active:true,type:"NOTE",timestamp:now},
associations:{dealIds:[Number(dealId)]},
metadata:{body:`Deliverables for Lead ${leadId}`},
attachments:fileIds.map(id=>({id:Number(id)}))
};

const res=await fetchJson("https://api.hubapi.com/engagements/v1/engagements",{
method:"POST",
headers:{...hsAuth,"Content-Type":"application/json"},
body:JSON.stringify(body)
});
if(!res.ok) throw new Error("Engagement create failed");
return String(res.json.engagement?.id||res.json.id);
}

/* =============================
   FILE UPLOAD
============================= */

const pdfBytes=Buffer.from(stripDataUrl(pdf_base64),"base64");
const csvBytes=new TextEncoder().encode(csv_text);

const pdfUp=await uploadFileToHubSpot({ bytes:pdfBytes, filename:`${lead_id}.pdf`, mimeType:"application/pdf" });
const csvUp=await uploadFileToHubSpot({ bytes:csvBytes, filename:`${lead_id}.csv`, mimeType:"text/csv" });

const fileIds=[pdfUp.fileId,csvUp.fileId];

/* =============================
   ENGAGEMENT NOTE
============================= */

const engagementNoteId=await createEngagementNoteWithAttachments({ dealId:deal_id, leadId:lead_id, fileIds });

/* =============================
   NEW PAYLOAD FIELDS PATCH
============================= */

const descDump = payload ? payloadToCsvDump(payload) : "";

const dealPatch = await patchDealWithFallback(deal_id,{
deliverable_pdf_file_id: pdfUp.fileId,
deliverable_csv_file_id: csvUp.fileId,
deliverable_note_id: engagementNoteId,
lead_status:"Deliverables Ready",

// ⭐ NEW CALCULATOR FIELDS
home_ownership: payload?.home_ownership || "",
time_line: payload?.time_line || "",
hsc_devices: payload?.devices || "",
hsc_package: payload?.package || "",
hsc_install_type: payload?.install_type || "",
hsc_monitoring: payload?.monitoring || "",
hsc_upfront: payload?.upfront || "",
hsc_monthly: payload?.monthly || "",

description: descDump
});

return {
statusCode:200,
headers:corsHeaders(event.headers?.origin),
body:JSON.stringify({
ok:true,
deal_id,
lead_id,
pdf_file_id:pdfUp.fileId,
csv_file_id:csvUp.fileId,
engagement_note_id:engagementNoteId
})
};

}catch(err){
return { statusCode:500, headers:corsHeaders(event.headers?.origin), body:JSON.stringify({ error:String(err.message||err) }) };
}
}
