// netlify/functions/ensure-line-item.js
export async function handler(event){

const allowedOrigins=[
"https://www.homesecurecalculator.com",
"https://homesecurecalculator.com",
"https://www.netcoreleads.com",
"https://netcoreleads.com",
"https://api.netcoreleads.com",
"https://hubspotgate.netlify.app",
];

function corsHeaders(originRaw){

const origin=(originRaw||"").trim();

const allowOrigin=origin
?allowedOrigins.includes(origin)
?origin
:allowedOrigins[0]
:"*";

return{

"Access-Control-Allow-Origin":allowOrigin,
"Access-Control-Allow-Headers":"Content-Type, Authorization",
"Access-Control-Allow-Methods":"POST, OPTIONS",
"Vary":"Origin",
"Cache-Control":"no-store",
"Content-Type":"application/json"

};

}

if(event.httpMethod==="OPTIONS"){

return{

statusCode:204,
headers:corsHeaders(event.headers?.origin),
body:""

};

}

if(event.httpMethod!=="POST"){

return{

statusCode:405,
headers:corsHeaders(event.headers?.origin),
body:JSON.stringify({error:"Method Not Allowed"})

};

}

const HS_TOKEN=
String(process.env.HUBSPOT_PRIVATE_APP_TOKEN||"").trim();

if(!HS_TOKEN){

return{

statusCode:500,
headers:corsHeaders(event.headers?.origin),
body:JSON.stringify({
error:"Missing HUBSPOT_PRIVATE_APP_TOKEN"
})

};

}

const hsAuth={Authorization:`Bearer ${HS_TOKEN}`};


// ---------- helpers ----------

async function sleep(ms){

return new Promise(r=>setTimeout(r,ms));

}

async function readText(res){

try{

return await res.text();

}catch{

return"";

}

}

async function fetchJson(url,options={}){

const res=await fetch(url,options);

const text=await readText(res);

let json=null;

try{

json=text?JSON.parse(text):null;

}catch{}

return{

ok:res.ok,
status:res.status,
json,
text

};

}


// ---------- PATCH SAFE ----------

async function patchWithFallback(objectType,id,properties){

const attempt=props=>fetchJson(

`https://api.hubapi.com/crm/v3/objects/${objectType}/${encodeURIComponent(id)}`,

{

method:"PATCH",

headers:{
...hsAuth,
"Content-Type":"application/json"
},

body:JSON.stringify({properties:props})

}

);

let r=await attempt(properties);

if(r.ok)return r;

const bad=new Set(

(r.json?.errors||[])
.filter(e=>e.code==="PROPERTY_DOESNT_EXIST")
.flatMap(e=>e.context?.propertyName||[])

);

if(bad.size){

const filtered=Object.fromEntries(

Object.entries(properties)
.filter(([k])=>!bad.has(k))

);

if(Object.keys(filtered).length){

r=await attempt(filtered);

}

}

return r;

}


// ---------- DEAL READY CHECK ----------

async function waitForDeal(dealId){

for(let i=0;i<6;i++){

const r=await fetchJson(

`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`,

{

method:"GET",
headers:hsAuth

}

);

if(r.ok)return true;

await sleep(800);

}

throw new Error(
`Deal not ready or missing ${dealId}`
);

}


// ---------- FIND CONTACT ----------

async function findContactId(email){

if(!email)return"";

const r=await fetchJson(

"https://api.hubapi.com/crm/v3/objects/contacts/search",

{

method:"POST",

headers:{
...hsAuth,
"Content-Type":"application/json"
},

body:JSON.stringify({

filterGroups:[{

filters:[{

propertyName:"email",
operator:"EQ",
value:email.toLowerCase()

}]

}],

limit:1

})

}

);

return r.json?.results?.[0]?.id||"";

}


// ---------- LINE ITEMS ----------

async function listDealLineItems(dealId){

const r=await fetchJson(

`https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/line_items`,

{

method:"GET",
headers:hsAuth

}

);

return(r.json?.results||[])
.map(x=>String(x.id));

}


async function createLineItem(name,price,currency){

const r=await fetchJson(

"https://api.hubapi.com/crm/v3/objects/line_items",

{

method:"POST",

headers:{
...hsAuth,
"Content-Type":"application/json"
},

body:JSON.stringify({

properties:{

name,
price:String(price),
quantity:"1",
hs_currency:currency

}

})

}

);

if(!r.ok||!r.json?.id){

throw new Error(

`Create line item failed ${r.text}`

);

}

return String(r.json.id);

}


async function updateLineItem(id,name,price,currency){

await patchWithFallback(

"line_items",
id,
{

name,
price:String(price),
quantity:"1",
hs_currency:currency

}

);

}


// ---------- ASSOCIATION (V4 SAFE) ----------

async function associateDealLineItem(dealId,lineItemId){

await waitForDeal(dealId);

const r=await fetchJson(

`https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/line_items/${lineItemId}`,

{

method:"PUT",

headers:{
...hsAuth,
"Content-Type":"application/json"
},

body:JSON.stringify({

types:[{

associationCategory:"HUBSPOT_DEFINED",
associationTypeId:19

}]

})

}

);

if(!r.ok){

throw new Error(

`Association failed ${r.text}`

);

}

}


// ---------- LOCATION ----------

function redact(city,state,zip){

const z=String(zip||"").match(/\d{3}/);

return[city,state]
.filter(Boolean)
.join(", ")+(z?` ${z[0]}xx`:"");

}


// ---------- MAIN ----------

try{

const body=
JSON.parse(event.body||"{}");

const{

deal_id,
lead_id,
email,
city,
state,
zip,
lead_price,
currency="USD"

}=body;

if(!deal_id||!lead_id){

throw new Error("Missing deal_id or lead_id");

}

if(!lead_price){

throw new Error("Invalid price");

}

await waitForDeal(deal_id);


const contactId=
await findContactId(email);


const dealname=
`Home Secure Lead — ${
redact(city,state,zip)||"Lead"
} — C${contactId||"NA"}`;


// ----- line item

let liList=
await listDealLineItems(deal_id);

let lineItemId=
liList[0];

if(!lineItemId){

lineItemId=
await createLineItem(

dealname,
lead_price,
currency

);

await associateDealLineItem(

deal_id,
lineItemId

);

}else{

await updateLineItem(

lineItemId,
dealname,
lead_price,
currency

);

}


// ----- patch deal

await patchWithFallback(

"deals",
deal_id,

{

dealname,
amount:String(lead_price),
lead_status:"Deliverables Processing"

}

);


return{

statusCode:200,
headers:corsHeaders(event.headers?.origin),

body:JSON.stringify({

ok:true,
deal_id,
line_item_id:lineItemId,
contact_id:contactId||null

})

};

}catch(err){

console.error(err);

return{

statusCode:500,
headers:corsHeaders(event.headers?.origin),

body:JSON.stringify({

error:"ensure-line-item failed",
detail:String(err.message||err)

})

};

}

}
