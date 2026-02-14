function renderRiskBadge(score) {

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
