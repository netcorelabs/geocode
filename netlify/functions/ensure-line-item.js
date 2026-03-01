exports.handler = async (event) => {
  try {
    const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
    if (!HUBSPOT_TOKEN) {
      return response(500, { error: "Missing HubSpot token" });
    }

    const body = JSON.parse(event.body || "{}");
    const { email, firstname, lastname, phone } = body;

    if (!email) {
      return response(400, { error: "Email required" });
    }

    /* =========================
       1️⃣  FIND OR CREATE CONTACT
    ==========================*/

    let contactId = await findContactByEmail(email, HUBSPOT_TOKEN);

    if (!contactId) {
      contactId = await createContact({
        email,
        firstname,
        lastname,
        phone
      }, HUBSPOT_TOKEN);
    }

    /* =========================
       2️⃣  CHECK FOR OPEN DEAL
    ==========================*/

    let dealId = await findOpenDeal(contactId, HUBSPOT_TOKEN);

    /* =========================
       3️⃣  CREATE DEAL IF NONE
    ==========================*/

    if (!dealId) {
      dealId = await createDeal({
        dealname: `${firstname || ""} ${lastname || ""} - Security Estimate`,
        pipeline: "default",
        dealstage: "appointmentscheduled" // change to your first stage
      }, HUBSPOT_TOKEN);

      await associateContactToDeal(contactId, dealId, HUBSPOT_TOKEN);
    }

    return response(200, { success: true, dealId });

  } catch (err) {
    return response(500, { error: err.message });
  }
};


/* ============================================================
   HELPERS
============================================================ */

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json"
});

function response(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

/* ========================= FIND CONTACT ========================= */

async function findContactByEmail(email, token) {
  const r = await fetch(
    "https://api.hubapi.com/crm/v3/objects/contacts/search",
    {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        filterGroups: [{
          filters: [{
            propertyName: "email",
            operator: "EQ",
            value: email
          }]
        }]
      })
    }
  );

  const data = await r.json();
  return data.results?.[0]?.id || null;
}

/* ========================= CREATE CONTACT ========================= */

async function createContact(props, token) {
  const r = await fetch(
    "https://api.hubapi.com/crm/v3/objects/contacts",
    {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ properties: props })
    }
  );

  const data = await r.json();
  return data.id;
}

/* ========================= FIND OPEN DEAL ========================= */

async function findOpenDeal(contactId, token) {
  const r = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals`,
    {
      headers: headers(token)
    }
  );

  const data = await r.json();
  if (!data.results?.length) return null;

  return data.results[0].toObjectId;
}

/* ========================= CREATE DEAL ========================= */

async function createDeal(props, token) {
  const r = await fetch(
    "https://api.hubapi.com/crm/v3/objects/deals",
    {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ properties: props })
    }
  );

  const data = await r.json();
  return data.id;
}

/* ========================= ASSOCIATE ========================= */

async function associateContactToDeal(contactId, dealId, token) {
  await fetch(
    `https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/contacts/${contactId}/deal_to_contact`,
    {
      method: "PUT",
      headers: headers(token)
    }
  );
}
