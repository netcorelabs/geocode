async function ensureProperty(propertyName) {

  const response = await fetch(
    `https://api.hubapi.com/crm/v3/properties/contacts/${propertyName}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_TOKEN}`
      }
    }
  );

  if (response.status === 404) {

    await fetch(
      "https://api.hubapi.com/crm/v3/properties/contacts",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: propertyName,
          label: propertyName.replace(/_/g, " "),
          type: "number",
          fieldType: "number"
        })
      }
    );
  }
}
