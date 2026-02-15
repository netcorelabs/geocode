// Autofill address + email from URL (optional, if calling page passes it)
document.addEventListener("DOMContentLoaded", function () {
  const params = new URLSearchParams(window.location.search);
  window.prefillAddress = params.get("address");
  window.prefillEmail = params.get("email");
});

// Set current year & calculator logic
document.addEventListener("DOMContentLoaded", () => {

  document.getElementById("year").textContent = new Date().getFullYear();

  const homeSizeEl = document.getElementById("homeSize");
  const installTypeEl = document.getElementById("installType");
  const complexityEls = document.querySelectorAll('input[name="complexity"]');

  const summaryTotalEl = document.getElementById("summaryTotal");
  const summaryMonitoringEl = document.getElementById("summaryMonitoring");
  const summaryBulletsEl = document.getElementById("summaryBullets");

  const equipmentPrices = {
    under1000: { basic: 300, standard: 500, premium: 800 },
    "1000_1999": { basic: 500, standard: 900, premium: 1500 },
    "2000_2999": { basic: 800, standard: 1500, premium: 2500 },
    "3000_3999": { basic: 1200, standard: 2200, premium: 3500 },
    "4000plus": { basic: 2000, standard: 3500, premium: 5000 }
  };

  const installMultipliers = { diy: 1, pro: 1.25 };
  const monitoringPrices = { basic: 25, standard: 50, premium: 75 };
  const deviceList = {
    basic: [
      "2–3 Security Cameras",
      "1 Video Doorbell",
      "2–3 Entry Sensors",
      "Smart Lock (1)",
      "Basic Alarm Panel"
    ],
    standard: [
      "4–6 Security Cameras",
      "Video Doorbell",
      "4–6 Entry Sensors",
      "Smart Lock(s)",
      "Smart Thermostat",
      "Smart Lighting (3–5 zones)",
      "Smart Alarm System"
    ],
    premium: [
      "6+ Security Cameras",
      "Video Doorbell + Chimes",
      "Full Entry Sensor Coverage",
      "Whole-Home Smart Locks",
      "Smart Thermostats",
      "Full Lighting Automation",
      "Advanced Alarm System",
      "Voice Assistant Integration",
      "Custom Automation Scenes"
    ]
  };

  function getComplexity(){
    return Array.from(complexityEls).find(r=>r.checked).value;
  }

  function updateEstimate(){
    const homeSize = homeSizeEl.value;
    const complexity = getComplexity();
    const installType = installTypeEl.value;

    const baseCost = equipmentPrices[homeSize][complexity];
    const totalCost = baseCost * installMultipliers[installType];
    const monitoring = monitoringPrices[complexity];

    summaryTotalEl.textContent = "$" + Math.round(totalCost).toLocaleString();
    summaryMonitoringEl.textContent = "$" + monitoring + "/mo";

    summaryBulletsEl.innerHTML = "";
    deviceList[complexity].forEach(device=>{
      const li = document.createElement("li");
      li.textContent = device;
      summaryBulletsEl.appendChild(li);
    });
  }

  [homeSizeEl, installTypeEl, ...complexityEls].forEach(el => el.addEventListener("change", updateEstimate));

  updateEstimate();
});
