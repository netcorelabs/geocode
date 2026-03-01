export async function handler(event){

if(event.httpMethod !== "POST"){

return{

statusCode:405,
body:"POST required"

};

}

const TOKEN =
process.env.HUBSPOT_PRIVATE_APP_TOKEN;

if(!TOKEN){

return{

statusCode:500,
body:"Missing token"

};

}

try{

const body =
JSON.parse(event.body);

if(!body.lead_id){

throw new Error(
"Missing lead_id"
);

}


// ---------- CREATE DEAL ----------

const response =
await fetch(

"https://api.hubapi.com/crm/v3/objects/deals",

{

method:"POST",

headers:{

Authorization:
`Bearer ${TOKEN}`,

"Content-Type":
"application/json"

},

body:JSON.stringify({

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

})

});

const text =
await response.text();

if(!response.ok){

throw new Error(text);

}

const result =
JSON.parse(text);

return{

statusCode:200,

body:JSON.stringify({

deal_id:result.id

})

};

}catch(e){

return{

statusCode:500,

body:e.message

};

}

}


