// netlify/functions/upload-deliverables.js

export async function handler(event){

// ---------- ALLOWED ORIGINS ----------

const allowedOrigins=[

"https://www.homesecurecalculator.com",
"https://homesecurecalculator.com",
"https://www.netcoreleads.com",
"https://netcoreleads.com",
"https://api.netcoreleads.com",
"https://hubspotgate.netlify.app"

];

function cors(origin){

return{

"Access-Control-Allow-Origin":
allowedOrigins.includes(origin)
? origin
: allowedOrigins[0],

"Access-Control-Allow-Headers":
"Content-Type,x-upload-key",

"Access-Control-Allow-Methods":
"POST,OPTIONS",

"Vary":"Origin"

};

}

// ---------- OPTIONS ----------

if(event.httpMethod==="OPTIONS"){

return{

statusCode:204,
headers:cors(event.headers?.origin),
body:""

};

}

if(event.httpMethod!=="POST"){

return{

statusCode:405,
headers:cors(event.headers?.origin),
body:"Method Not Allowed"

};

}


// ---------- SECURITY ----------

const origin=event.headers?.origin||"";

if(!allowedOrigins.includes(origin)){

return{

statusCode:403,
headers:cors(origin),
body:"Forbidden"

};

}

if(
event.headers["x-upload-key"]
!==process.env.UPLOAD_SECRET
){

return{

statusCode:403,
headers:cors(origin),
body:"Invalid Signature"

};

}


// ---------- RATE LIMIT ----------

global.lastUploads=
global.lastUploads||new Map();

const ip=
event.headers[
"x-nf-client-connection-ip"
]||"unknown";

const now=Date.now();

if(global.lastUploads.has(ip)){

if(now-
global.lastUploads.get(ip)
<4000){

return{

statusCode:429,
headers:cors(origin),
body:"Too Fast"

};

}

}

global.lastUploads.set(ip,now);


// ---------- ENV ----------

const TOKEN=
process.env
.HUBSPOT_PRIVATE_APP_TOKEN;

if(!TOKEN){

return{

statusCode:500,
headers:cors(origin),
body:"Missing Token"

};

}

const folderPath=
process.env
.HUBSPOT_FILES_FOLDER_PATH
||"/lead_store_deliverables";

const HS_AUTH={

Authorization:`Bearer ${TOKEN}`

};


// ---------- HELPERS ----------

async function text(res){

try{return await res.text();}
catch{return"";}

}

async function fetchJson(url,opt={}){

const r=await fetch(url,opt);

const t=await text(r);

let j=null;

try{

j=t?JSON.parse(t):null;

}catch{}

return{

ok:r.ok,
json:j,
text:t,
status:r.status

};

}


// ---------- HUBSPOT ----------

async function hsPost(path,body){

return fetchJson(

`https://api.hubapi.com${path}`,

{

method:"POST",

headers:{

...HS_AUTH,
"Content-Type":
"application/json"

},

body:JSON.stringify(body)

}

);

}


async function hsPatch(path,body){

return fetchJson(

`https://api.hubapi.com${path}`,

{

method:"PATCH",

headers:{

...HS_AUTH,
"Content-Type":
"application/json"

},

body:JSON.stringify(body)

}

);

}


// ---------- FIND DEAL ----------

async function findDeal(lead_id){

const r=
await hsPost(

"/crm/v3/objects/deals/search",

{

filterGroups:[{

filters:[{

propertyName:"lead_id",

operator:"EQ",

value:String(lead_id)

}]

}],

limit:1

}

);

return r.ok &&
r.json?.results?.[0]?.id
? r.json.results[0].id
: null;

}


// ---------- CREATE DEAL ----------

async function createDeal(body){

const r=await hsPost(

"/crm/v3/objects/deals",

{

properties:{

dealname:
body.deal_name,

amount:
body.deal_amount,

pipeline:
body.pipeline,

dealstage:
body.stage,

closedate:
body.close_date,

dealtype:
body.deal_type,

lead_id:
body.lead_id

}

}

);

if(!r.ok){

throw new Error(

"Deal create failed "
+r.text

);

}

return r.json.id;

}


// ---------- FILE UPLOAD ----------

async function uploadFile(

buffer,
name,
mime

){

const f=new FormData();

f.append(

"file",

new Blob([buffer],
{type:mime}),
name

);

f.append("fileName",name);

f.append(
"folderPath",
folderPath
);

f.append(

"options",

JSON.stringify({

access:"PRIVATE"

})

);

const r=await fetch(

"https://api.hubapi.com/files/v3/files",

{

method:"POST",
headers:HS_AUTH,
body:f

}

);

const t=await text(r);

let j=null;

try{

j=t?JSON.parse(t):null;

}catch{}

if(!r.ok){

throw new Error(
"Upload failed "+t
);

}

return String(j?.id||"");

}


// ---------- MAIN ----------

try{

const body=
JSON.parse(event.body||"{}");

const lead_id=
String(body.lead_id||"")
.trim();

if(!lead_id){

throw new Error(
"Missing lead_id"
);

}


// ---------- FIND OR CREATE DEAL ----------

let dealId=
await findDeal(lead_id);

if(!dealId){

dealId=
await createDeal(body);

}


// ---------- DUPLICATE CHECK ----------

const existing=
await fetchJson(

`https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=deliverable_pdf_file_id`,

{headers:HS_AUTH}

);

if(

existing?.json?.properties
?.deliverable_pdf_file_id

){

return{

statusCode:409,
headers:cors(origin),
body:"Already Uploaded"

};

}


// ---------- FILES ----------

const pdfBuffer=
Buffer.from(
body.pdf_base64,
"base64"
);

const csvBuffer=
Buffer.from(
body.csv_text,
"utf8"
);


// ---------- SIZE LIMIT ----------

if(pdfBuffer.length>
8_000_000){

throw new Error(
"PDF too large"
);

}


const pdfId=
await uploadFile(

pdfBuffer,

`lead-${lead_id}.pdf`,

"application/pdf"

);

const csvId=
await uploadFile(

csvBuffer,

`lead-${lead_id}.csv`,

"text/csv"

);


// ---------- PATCH DEAL ----------

await hsPatch(

`/crm/v3/objects/deals/${dealId}`,

{

properties:{

deliverable_pdf_file_id:
pdfId,

deliverable_csv_file_id:
csvId,

deliverables_uploaded:true

}

}

);


// ---------- AI WEBHOOK ----------

if(process.env.AI_WEBHOOK){

await fetch(

process.env.AI_WEBHOOK,

{

method:"POST",

headers:{
"Content-Type":
"application/json"
},

body:JSON.stringify({

dealId,
lead_id

})

}

);

}


// ---------- SUCCESS ----------

return{

statusCode:200,

headers:cors(origin),

body:JSON.stringify({

ok:true,
deal_id:dealId,
pdf_file_id:pdfId,
csv_file_id:csvId

})

};

}catch(e){

console.error(e);

return{

statusCode:500,

headers:cors(
event.headers?.origin
),

body:JSON.stringify({

error:e.message

})

};

}

}
