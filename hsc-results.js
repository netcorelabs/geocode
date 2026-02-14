function renderRiskBadge(score) {
function updateRiskUI(score, crime, homeRisk, protection) {

  document.getElementById("riskScore").textContent = score;

  renderRiskBadge(score);

 if (score >= 40) {
  fireConversionEvent(score);
}


}
function fireConversionEvent(finalScore) {

  // Prevent duplicate firing
  if (window.hscConversionFired) return;
  window.hscConversionFired = true;

  const trafficSource = localStorage.getItem("utm_source") || "direct";

  /* ===============================
     GOOGLE ANALYTICS 4
  =============================== */
  if (window.gtag) {
    gtag("event", "security_estimate_completed", {
      risk_score: finalScore,
      traffic_source: trafficSource
    });
  }

  /* ===============================
     FACEBOOK / META
  =============================== */
  if (window.fbq) {
    fbq("trackCustom", "SecurityEstimateCompleted", {
      riskScore: finalScore,
      source: trafficSource
    });
  }

  /* ===============================
     OPTIONAL: HubSpot Event
  =============================== */
  if (window._hsq) {
    _hsq.push([
      "trackCustomBehavioralEvent",
      {
        name: "security_estimate_completed",
        properties: {
          risk_score: finalScore,
          utm_source: trafficSource
        }
      }
    ]);
  }

}

  let label, color;

  if (score < 40) {
    label = "Low Risk";
    color = "#16a34a";
  } else if (score < 70) {
    label = "Moderate Risk";
    color = "#f59e0b";
  } else {
    label = "High Risk";
    color = "#dc2626";
  }

  document.getElementById("riskBadge").innerHTML =
    `<span style="
      background:${color};
      color:white;
      padding:8px 16px;
      border-radius:50px;
      font-weight:600;">
      ${label}
    </span>`;
}
