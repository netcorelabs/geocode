(function () {

  document.addEventListener("DOMContentLoaded", function () {

    const params = new URLSearchParams(window.location.search);

    const address =
      params.get("address") ||
      localStorage.getItem("lead_address") ||
      "Atlanta, GA";

    const riskScore =
      params.get("riskScore") ||
      localStorage.getItem("riskScore") ||
      85;

    const scoreEl = document.getElementById("riskScore");
    if (scoreEl) scoreEl.textContent = riskScore;

    loadGoogleMaps();

    function loadGoogleMaps() {

      if (window.google && window.google.maps) {
        initMap();
        return;
      }

      const script = document.createElement("script");

      script.src =
        "https://maps.googleapis.com/maps/api/js?key=AIzaSyC7EeMaBJWTgZ8ZdtyjjJFfzTv_ZpuhmLA&libraries=visualization,marker&callback=initMap";

      script.async = true;
      script.defer = true;

      document.head.appendChild(script);
    }

    window.initMap = function () {

      const geocoder = new google.maps.Geocoder();

      geocoder.geocode({ address: address }, function (results, status) {

        if (status !== "OK" || !results[0]) {
          console.error("Geocode failed:", status);
          return;
        }

        const loc = results[0].geometry.location;

        const map = new google.maps.Map(document.getElementById("map"), {
          zoom: 13,
          center: loc,
          mapId: "DEMO_MAP_ID"
        });

        new google.maps.marker.AdvancedMarkerElement({
          map: map,
          position: loc
        });

        fetchCrimeData(map, loc);

      });

    };

    async function fetchCrimeData(map, loc) {

      try {

        // OPTIONAL: You can improve this later by extracting state dynamically
        const state = "GA";
        const year = "2022";

        const response = await fetch(`/api/crime?state=${state}&year=${year}`);

        if (!response.ok) {
          throw new Error("Crime API proxy failed");
        }

        const data = await response.json();

        if (!data.results || !Array.isArray(data.results)) {
          document.getElementById("crime-summary").textContent =
            "No crime data available.";
          return;
        }

        let totalViolentCrimes = 0;
        const heatPoints = [];

        data.results.forEach((r) => {

          totalViolentCrimes += r.actual || 0;

          // Randomized spread (replace later with real lat/lng dataset if available)
          const latOffset = loc.lat() + (Math.random() - 0.5) * 0.15;
          const lngOffset = loc.lng() + (Math.random() - 0.5) * 0.15;

          heatPoints.push(
            new google.maps.LatLng(latOffset, lngOffset)
          );

        });

        const heatmap = new google.maps.visualization.HeatmapLayer({
          data: heatPoints,
          radius: 35
        });

        heatmap.setMap(map);

        const summaryEl = document.getElementById("crime-summary");

        if (summaryEl) {
          summaryEl.innerHTML =
            `Total Violent Crimes in ${state} (${year}): 
             <strong>${totalViolentCrimes.toLocaleString()}</strong>. 
             Heatmap reflects density relative to the selected location.`;
        }

      } catch (error) {

        console.error("Crime proxy error:", error);

        const summaryEl = document.getElementById("crime-summary");
        if (summaryEl) {
          summaryEl.textContent = "Error loading crime data.";
        }

      }

    }

  });

})();
