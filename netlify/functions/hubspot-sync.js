// netlify/functions/hubspot-sync.js

export async function handler(event){

const headers={

"Access-Control-Allow-Origin":"*",

"Access-Control-Allow-Headers":"Content-Type",

"Access-Control-Allow-Methods":"POST, OPTIONS"

};

if(event.httpMethod==="OPTIONS")

return{

statusCode:200,

headers,

body:"ok"

};


try{

const HS_TOKEN=process.env.HUBSPOT_PRIVATE_APP_TOKEN;

if(!HS_TOKEN){

return{

statusCode:500,

headers,

body:JSON.stringify({

error:"Missing HUBSPOT_PRIVATE_APP_TOKEN"

})

};

}


const hsAuth={

Authorization:`Bearer ${HS_TOKEN}`,

"Content-Type":"application/json"

};


const body=JSON.parse(event.body||"{}");

const payload=body.payload||{};

const email=String(payload.email||"").trim().toLowerCase();


if(!email){

return{

statusCode:400,

headers,

body:JSON.stringify({

error:"Missing email"

})

};

}


const lead_id=

payload.lead_id||

Date.now().toString();


/* ==========================
CONTACT UPSERT
========================== */

let contactId="";


const contactSearch=await fetch(

"https://api.hubapi.com/crm/v3/objects/contacts/search",

{

method:"POST",

headers:hsAuth,

body:JSON.stringify({

filterGroups:[{

filters:[{

propertyName:"email",

operator:"EQ",

value:email

}]

}],

limit:1

})

}

);


const contactJson=await contactSearch.json();


if(contactJson.results?.length){

contactId=

contactJson.results[0].id;

}else{


const createContact=await fetch(

"https://api.hubapi.com/crm/v3/objects/contacts",

{

method:"POST",

headers:hsAuth,

body:JSON.stringify({

properties:{

email

}

})

}

);


const contactCreateJson=

await createContact.json();


contactId=

contactCreateJson.id;

}


/* ==========================
CREATE DEAL
========================== */

const createDeal=await fetch(

"https://api.hubapi.com/crm/v3/objects/deals",

{

method:"POST",

headers:hsAuth,

body:JSON.stringify({

properties:{

dealname:

`Home Secure Lead — ${payload.home_ownership||""} ${payload.time_line||""}`,

lead_id,

pipeline:"default",

dealstage:"appointmentscheduled"

}

})

}

);


const dealJson=

await createDeal.json();


const dealId=

dealJson.id;


if(!dealId){

throw new Error(

"Deal create failed"

);

}


/* ==========================
ASSOCIATE CONTACT → DEAL
========================== */

await fetch(

`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`+

`/associations/contacts/${contactId}/3`,

{

method:"PUT",

headers:hsAuth

}

);


/* ==========================
WAIT UNTIL HUBSPOT READY
========================== */

for(let i=0;i<12;i++){

const check=await fetch(

`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`,

{

method:"GET",

headers:hsAuth

}

);

if(check.ok){

break;

}

await new Promise(r=>

setTimeout(r,1000)

);

}


/* ==========================
RETURN
========================== */

return{

statusCode:200,

headers,

body:JSON.stringify({

ok:true,

deal_id:dealId,

lead_id,

contact_id:contactId

})

};

}catch(e){

console.error(e);

return{

statusCode:500,

headers,

body:JSON.stringify({

error:e.message

})

};

}

}
