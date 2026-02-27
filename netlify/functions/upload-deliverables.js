// netlify/functions/upload-deliverables.js
import FormData from "form-data";
import fetch from "node-fetch";

const FOLDER_ID = String(process.env.HUBSPOT_FILES_FOLDER_ID || "").trim();
const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
const hsAuth = { Authorization:`Bearer ${HS_TOKEN}` };

async function fetchJson(url, options={}) {
  const r = await fetch(url, options);
  const t = await r.text().catch(()=>"");
  let j=null; try{ j = t ? JSON.parse(t):null } catch{ j=null }
  return { ok:r.ok, status:r.status, json:j, text:t };
}

async function uploadFile(bytes, name, mime){
  const form = new FormData();
  form.append("file", new Blob([bytes],{type:mime}), name);
  const r = await fetchJson(`https://api.hubapi.com/files/v3/files?folderId=${FOLDER_ID}`, {method:"POST", headers: hsAuth, body: form});
  if(!r.ok || !r.json?.id) throw new Error("Upload failed: "+(r.text||JSON.stringify(r.json)));
  return r.json.id;
}

async function createNote(dealId, fileIds){
  const r = await fetchJson("https://api.hubapi.com/crm/v3/objects/notes",{
    method:"POST",
    headers: { ...hsAuth, "Content-Type":"application/json" },
    body: JSON.stringify({
      properties: { hs_note_body:`Deliverables for deal ${dealId}`, hs_attachment_ids:fileIds.join(";") }
    })
  });
  if(!r.ok || !r.json?.id) throw new Error("Note create failed");
  await fetchJson(`https://api.hubapi.com/crm/v3/objects/notes/${r.json.id}/associations/deals/${dealId}/20`,{method:"PUT",headers:hsAuth});
  return r.json.id;
}

async function cleanupOrphans(){
  const files = await fetchJson(`https://api.hubapi.com/files/v3/files?folderId=${FOLDER_ID}&limit=100`,{method:"GET", headers:hsAuth});
  const deals = await fetchJson(`https://api.hubapi.com/crm/v3/objects/deals?limit=100`,{method:"GET",headers:hsAuth});
  const valid = new Set(deals.json?.results?.map(d=>String(d.id)||"")||[]);
  for(const f of files.json?.results||[]){
    const assoc = f.associations?.deals?.map(a=>String(a.id)||"")||[];
    if(!assoc.some(a=>valid.has(a))) await fetchJson(`https://api.hubapi.com/files/v3/files/${f.id}`,{method:"DELETE",headers:hsAuth});
  }
}

export async function handler(event){
  try{
    const b = JSON.parse(event.body||"{}");
    const { deal_id, pdf_base64, csv_text, pdf_filename, csv_filename } = b;
    if(!deal_id || !pdf_base64 || !csv_text) return { statusCode:400, body:JSON.stringify({error:"Missing fields"}) };

    const pdfId = await uploadFile(Buffer.from(pdf_base64,"base64"), pdf_filename||`lead-${deal_id}.pdf`, "application/pdf");
    const csvId = await uploadFile(Buffer.from(csv_text,"utf-8"), csv_filename||`lead-${deal_id}.csv`, "text/csv");

    const noteId = await createNote(deal_id,[pdfId,csvId]);

    await cleanupOrphans();

    return { statusCode:200, body:JSON.stringify({ok:true,pdfId,csvId,noteId}) };
  } catch(err){
    return { statusCode:500, body:JSON.stringify({error:String(err)}) };
  }
}
