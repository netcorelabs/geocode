(function(){

document.addEventListener("DOMContentLoaded", async function() {

  const root = document.getElementById("results-root");
  if (!root) return;
<script>
document.addEventListener("DOMContentLoaded", function() {
  // Try to get address from URL first, then fallback to localStorage
  const params = new URLSearchParams(window.location.search);
  const address = params.get("address") || localStorage.getItem("lead_address") || "Atlanta, GA";
  const riskScore = params.get("riskScore") || 85;

  document.getElementById("riskScore").textContent = riskScore;

  // Load Google Maps async
  function loadGoogle() {
    const s = document.createElement("script");
    s.src = "https://maps.googleapis.com/maps/api/js?key=YOUR_GOOGLE_KEY&libraries=visualization,marker";
    s.async = true;
    s.defer = true;
    s.onload = initMap;
    document.head.appendChild(s);
  }

  function initMap() {
    const geocoder = new google.maps.Geocoder();

    geocoder.geocode({ address: address }, function(results, status) {
      if (status !== "OK" || !results[0]) {
        console.error("Geocoding failed", status);
        return;
      }

      const loc = results[0].geometry.location;

      const map = new google.maps.Map(document.getElementById("map"), {
        zoom: 13,
        center: loc
      });

      // Use AdvancedMarkerElement instead of deprecated Marker
      new google.maps.marker.AdvancedMarkerElement({
        map: map,
        position: loc,
      });

      // Call function to fetch crime data
      fetchCrimeData(map, loc);
    });
  }

  async function fetchCrimeData(map, loc) {
    try {
      const state = "GA"; // could dynamically detect from address
      const year = "2022";

      const res = await fetch(
        `https://api.usa.gov/crime/fbi/sapi/api/summarized/state/${state}/violent-crime/${year}/${year}?api_key=YOUR_FBI_KEY`
      );
      const data = await res.json();
      if (!data.results) return;

      const heatPoints = [];

      data.results.forEach(r => {
        const latOffset = loc.lat() + (Math.random() - 0.5) * 0.15;
        const lngOffset = loc.lng() + (Math.random() - 0.5) * 0.15;
        heatPoints.push(new google.maps.LatLng(latOffset, lngOffset));
      });

      const heatmap = new google.maps.visualization.HeatmapLayer({
        data: heatPoints,
        radius: 35
      });

      heatmap.setMap(map);
    } catch (e) {
      console.error("FBI API error", e);
    }
  }

  loadGoogle();
});
</script>

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
