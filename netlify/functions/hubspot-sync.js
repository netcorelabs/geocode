// netlify/functions/hubspot-sync.js
import fetch from "node-fetch";

export async function handler(event) {
  const HS_TOKEN = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || "").trim();
  if(!HS_TOKEN) return { statusCode:500, body:JSON.stringify({error:"Missing HS token"})};
  const hsAuth = { Authorization:`Bearer ${HS_TOKEN}`, "Content-Type":"application/json" };

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch(e){}

  const payload = body.payload || {};
  const email = String(payload.email || "").trim();
  if(!email) return { statusCode:400, body:JSON.stringify({error:"Missing payload.email"})};

  let lead_id = String(payload.lead_id || "");
  if(!lead_id) lead_id = crypto.randomUUID?.() || String(Date.now()) + "-" + Math.random().toString(16).slice(2);

  // 1) Search for existing deal by email
  const searchRes = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/search`,{
    method:"POST",
    headers: hsAuth,
    body: JSON.stringify({
      filterGroups:[{filters:[{propertyName:"email",operator:"EQ",value:email}]}],
      properties:["dealname","dealstage"]
    })
  });
  const searchJson = await searchRes.json();
  let dealId = searchJson.results?.[0]?.id || null;

  // 2) If not found, create deal
  if(!dealId){
    const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals",{
      method:"POST",
      headers: hsAuth,
      body: JSON.stringify({
        properties:{
          dealname:`HSC Lead ${payload.firstname||""} ${payload.lastname||""}`,
          email,
          lead_id
        }
      })
    });
    const createJson = await createRes.json();
    dealId = createJson.id;
  }

  // 3) Return info
  return { statusCode:200, body:JSON.stringify({ ok:true, lead_id, deal_id:dealId }) };
}
