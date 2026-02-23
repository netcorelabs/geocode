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


// ---------- CORS ----------

function corsHeaders(origin){

const safeOrigin =
allowedOrigins.includes(origin)
? origin
: allowedOrigins[0];

return{

"Access-Control-Allow-Origin":safeOrigin,

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

headers:corsHeaders(
event.headers?.origin
),

body:""

};

}


if(event.httpMethod!=="POST"){

return{

statusCode:405,

headers:corsHeaders(
event.headers?.origin
),

body:"Method Not Allowed"

};

}


// ---------- BASIC SECURITY ----------

const origin =
event.headers?.origin || "";

if(!allowedOrigins.includes(origin)){

return{

statusCode:403,

headers:corsHeaders(origin),

body:"Forbidden"

};

}


// ---------- SECRET SIGNATURE ----------

const signature =
event.headers["x-upload-key"];

if(
signature !==
process.env.UPLOAD_SECRET
){

return{

statusCode:403,

headers:corsHeaders(origin),

body:"Invalid signature"

};

}


// ---------- RATE LIMIT ----------

global.lastUploads =
global.lastUploads || new Map();

const ip =
event.headers[
"x-nf-client-connection-ip"
] || "unknown";

const now = Date.now();

if(global.lastUploads.has(ip)){

const last =
global.lastUploads.get(ip);

if(now-last < 5000){

return{

statusCode:429,

headers:corsHeaders(origin),

body:"Too many uploads"

};

}

}

global.lastUploads.set(ip,now);


// ---------- ENV ----------

const HS_TOKEN =
process.env.HUBSPOT_PRIVATE_APP_TOKEN;

if(!HS_TOKEN){

return{

statusCode:500,

headers:corsHeaders(origin),

body:"Missing HUBSPOT token"

};

}

const folderPath =
process.env
.HUBSPOT_FILES_FOLDER_PATH
|| "/lead_store_deliverables";


// ---------- HELPERS ----------

async function readText(res){

try{

return await res.text();

}catch{

return "";

}

}


async function fetchJson(url,options={}){

const res = await fetch(url,options);

const text = await readText(res);

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


const HS_AUTH={

Authorization:`Bearer ${HS_TOKEN}`

};


async function hsPatch(path,body){

return fetchJson(

`https://api.hubapi.com${path}`,

{

method:"PATCH",

headers:{

...HS_AUTH,

"Content-Type":"application/json"

},

body:JSON.stringify(body)

}

);

}


// ---------- FILE UPLOAD ----------

async function uploadPrivateFile({

buffer,

filename,

mime

}){

const form=new FormData();

form.append(

"file",

new Blob([buffer],{

type:mime

}),

filename

);

form.append(

"fileName",

filename

);

form.append(

"folderPath",

folderPath

);

form.append(

"options",

JSON.stringify({

access:"PRIVATE"

})

);


const res = await fetch(

"https://api.hubapi.com/files/v3/files",

{

method:"POST",

headers:HS_AUTH,

body:form

}

);

const text=await readText(res);

let json=null;

try{

json=text?JSON.parse(text):null;

}catch{}

if(!res.ok){

throw new Error(

`Upload Failed ${res.status} ${text}`

);

}

return{

fileId:String(json?.id||"")

};

}


// ---------- MAIN ----------

try{

const body =
JSON.parse(event.body||"{}");

const dealId =
String(body.deal_id||"")
.trim();

const lead_id =
String(body.lead_id||"")
.trim();

const pdf_base64 =
String(body.pdf_base64||"")
.trim();

const csv_text =
String(body.csv_text||"")
.trim();


if(

!dealId ||
!lead_id ||
!pdf_base64 ||
!csv_text

){

return{

statusCode:400,

headers:corsHeaders(origin),

body:"Missing data"

};

}


// ---------- FILE SIZE PROTECTION ----------

if(pdf_base64.length>8000000){

throw new Error(

"PDF too large"

);

}


// ---------- DUPLICATE CHECK ----------

const existing =
await fetchJson(

`https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=deliverable_pdf_file_id`,

{

headers:HS_AUTH

}

);


if(

existing?.json?.properties
?.deliverable_pdf_file_id

){

return{

statusCode:409,

headers:corsHeaders(origin),

body:"Deliverables exist"

};

}


// ---------- CONVERT FILES ----------

const pdfBuffer =
Buffer.from(

pdf_base64,

"base64"

);

const csvBuffer =
Buffer.from(

csv_text,

"utf8"

);


const pdfName =
`lead-${lead_id}.pdf`;

const csvName =
`lead-${lead_id}.csv`;


// ---------- UPLOAD ----------

const pdfUp =
await uploadPrivateFile({

buffer:pdfBuffer,

filename:pdfName,

mime:"application/pdf"

});


const csvUp =
await uploadPrivateFile({

buffer:csvBuffer,

filename:csvName,

mime:"text/csv"

});


// ---------- PATCH DEAL ----------

await hsPatch(

`/crm/v3/objects/deals/${dealId}`,

{

properties:{

deliverable_pdf_file_id:
pdfUp.fileId,

deliverable_csv_file_id:
csvUp.fileId,

deliverables_uploaded:true

}

}

);


// ---------- OPTIONAL AI TRIGGER ----------

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

headers:corsHeaders(origin),

body:JSON.stringify({

ok:true,

deal_id:dealId,

pdf_file_id:
pdfUp.fileId,

csv_file_id:
csvUp.fileId

})

};

}catch(err){

console.error(

"upload-deliverables error",

err

);

return{

statusCode:500,

headers:corsHeaders(
event.headers?.origin
),

body:JSON.stringify({

error:err.message

})

};

}

}
