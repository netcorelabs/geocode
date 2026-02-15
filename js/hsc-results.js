(function(){

document.addEventListener("DOMContentLoaded", async function() {

  const root = document.getElementById("results-root");
  if (!root) return;

  root.innerHTML = "<p>Loading your security report...</p>";

  try {

    // 1️⃣ Get email from URL
    const params = new URLSearchParams(window.location.search);
    const email = params.get("email");

    if (!email) {
      root.innerHTML = "<p>Missing session email.</p>";
      return;
    }

    // 2️⃣ Get stored data (HubSpot domain localStorage)
    const address = localStorage.getItem("lead_address");
    const homeValue = localStorage.getItem("calc_home_value");
    const securityLevel = localStorage.getItem("calc_security_level");

    if (!address) {
      root.innerHTML = "<p>Missing address data.</p>";
      return;
    }

    // 3️⃣ Geocode address
    const geoRes = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=AIzaSyCQjLZxTOSGUhHJ8__vymBaFTpLVAZcBzc`
    );

    const geoData = await geoRes.json();

    if (!geoData.results || !geoData.results.length) {
      root.innerHTML = "<p>Unable to locate address.</p>";
      return;
    }

    const { lat, lng } = geoData.results[0].geometry.location;

    // 4️⃣ Get crime score from Netlify
    const crimeRes = await fetch(
      `https://hubspotgate.netlify.app/.netlify/functions/crime-score?lat=${lat}&lng=${lng}`
    );

    const crimeData = await crimeRes.json();

    if (!crimeRes.ok) {
      root.innerHTML = "<p>Unable to retrieve crime data.</p>";
      return;
    }

    const riskScore = crimeData.weightedCrimeScore;
    const riskLevel = crimeData.riskLevel;
    const totalCrimes = crimeData.totalCrimes;

    // 5️⃣ Simple cost logic example
    const equipmentCost = Number(homeValue || 0) * 0.01;
    const installCost = 199;
    const monitoringCost = securityLevel === "premium" ? 59 : 
                           securityLevel === "standard" ? 39 : 19;

    // 6️⃣ Display results
    root.innerHTML = `
      <div class="result-card">
        <p><strong>Address:</strong> ${address}</p>
        <p><strong>Total Crimes (1mi):</strong> ${totalCrimes}</p>
        <p><strong>Crime Score:</strong> ${riskScore}</p>
        <p><strong>Risk Level:</strong> ${riskLevel}</p>
        <hr/>
        <p><strong>Recommended Plan:</strong> ${securityLevel}</p>
        <p><strong>Equipment Estimate:</strong> $${equipmentCost.toFixed(2)}</p>
        <p><strong>Installation:</strong> $${installCost}</p>
        <p><strong>Monitoring:</strong> $${monitoringCost}/mo</p>
      </div>
    `;

    // 7️⃣ Update HubSpot Contact
    await fetch(
      "https://hubspotgate.netlify.app/.netlify/functions/hubspotUpdate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          riskScore,
          systemSummary: `${riskLevel} risk area`,
          equipment: equipmentCost,
          install: installCost,
          monitoring: monitoringCost,
          devices: ["Alarm Panel", "Door Sensors", "Camera"],
          address
        })
      }
    );

  } catch (err) {
    root.innerHTML = "<p>Unexpected error loading results.</p>";
    console.error(err);
  }

});

})();
