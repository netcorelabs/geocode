<!-- ==============================
   HSC RESULTS V6.5 (CSP SAFE)
   ✅ Maps / Heatmap / Charts / PDF
   ✅ Line item & deal amount integration
   ✅ Mobile maps toggle
   ✅ HubSpot CSP safe (no eval / unsafe scripts)
   ✅ Redirects to /hscthankyou
=============================== -->

<style>
  /* === Layout & Responsive === */
  #hscResultsGrid {
    max-width: 1500px;
    margin: auto;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 40px;
    align-items: start;
  }
  @media (max-width: 980px) {
    #hscResultsGrid { grid-template-columns: 1fr; gap: 18px; }
    #hscMapsToggleWrap { display: block !important; }
    #hscMapsPanel { display: none; }
  }
  @media (min-width: 981px) {
    #hscMapsToggleWrap { display: none !important; }
    #hscMapsPanel { display: flex; }
  }
</style>

<div style="font-family:Inter,Segoe UI,sans-serif;background:#f4f6fb;padding:60px 20px;min-height:100vh;">
  <div id="hscResultsGrid">
    <!-- LEFT PANEL -->
    <div style="background:#fff;border-radius:18px;padding:40px;border:1px solid #e5e7eb;box-shadow:0 20px 60px rgba(0,0,0,.06);display:flex;flex-direction:column;gap:18px;">
      <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;">
        <div>
          <div style="color:#2563eb;font-weight:900;letter-spacing:.14em;text-transform:uppercase;font-size:12px;">Security Intelligence</div>
          <h2 style="margin:8px 0 6px;font-size:30px;line-height:1.1;color:#111827;">Executive Risk Report</h2>
          <div style="color:#6b7280;font-size:14px;">Risk scoring + crime intelligence + location assessment.</div>
        </div>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:14px;min-width:280px;">
          <div style="color:#6b7280;font-size:12px;">Report Status</div>
          <div id="statusText" style="color:#111827;font-weight:900;margin-top:4px;">Loading…</div>
          <div id="statusSub" style="color:#6b7280;font-size:12px;margin-top:2px;">Initializing</div>
        </div>
      </div>

      <!-- Mobile maps toggle -->
      <div id="hscMapsToggleWrap" style="display:none;">
        <button id="hscToggleMapsBtn" type="button"
          style="width:100%;padding:12px;border:1px solid #e5e7eb;border-radius:14px;background:#fff;font-weight:900;cursor:pointer;">
          Show Maps ▾
        </button>
        <div style="font-size:12px;color:#6b7280;margin-top:6px;">
          Tip: Maps are hidden on mobile to keep the report readable.
        </div>
      </div>

      <!-- Totals / Devices -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:14px;">
          <div style="color:#6b7280;font-size:12px;">Client</div>
          <div id="contact" style="margin-top:6px;color:#111827;font-weight:800;line-height:1.35;"></div>
        </div>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:14px;">
          <div style="color:#6b7280;font-size:12px;">Totals</div>
          <div id="totals" style="margin-top:6px;color:#111827;font-weight:900;line-height:1.35;"></div>
          <div style="margin-top:10px;border-top:1px solid #e5e7eb;padding-top:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div style="color:#6b7280;font-size:12px;font-weight:800;">Selections</div>
              <div id="deviceCountBadge"
                style="font-size:12px;font-weight:900;color:#111827;background:#fff;border:1px solid #e5e7eb;border-radius:999px;padding:4px 10px;">0 devices</div>
            </div>
            <div id="deviceList" style="margin-top:8px;max-height:86px;overflow:auto;padding-right:6px;"></div>
            <div id="planLine" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;"></div>
          </div>
        </div>
      </div>

      <div id="riskZoneBox" style="padding:14px;border-radius:14px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:900;color:#111827;">
        Risk Zone: <span id="riskZoneText">—</span>
        <span id="riskScoreText" style="float:right;">—/100</span>
      </div>

      <!-- Charts -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;">
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px;">
          <div style="font-weight:900;color:#111827;margin-bottom:8px;">Risk Gauge</div>
          <canvas id="riskChart" height="140"></canvas>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px;">
          <div style="font-weight:900;color:#111827;margin-bottom:8px;">Crime Severity</div>
          <canvas id="severityChart" height="140"></canvas>
        </div>
      </div>
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div style="font-weight:900;color:#111827;">Crime Trend</div>
          <div style="font-size:12px;color:#6b7280;">12-month approximation from FBI totals</div>
        </div>
        <canvas id="crimeTrendChart" height="120"></canvas>
      </div>

      <div id="percentileBox" style="background:#f9fafb;padding:14px;border-radius:14px;border:1px solid #e5e7eb;color:#111827;"></div>
      <div id="aiExplanation" style="background:#f3f4f6;padding:14px;border-radius:14px;border:1px solid #e5e7eb;color:#111827;"></div>

      <button id="downloadPDF_exec" style="padding:14px;border:none;border-radius:14px;background:#111827;color:#fff;font-weight:900;cursor:pointer;">
        Continue to Download PDF →
      </button>

      <div style="font-size:12px;color:#6b7280;line-height:1.45;">
        Disclaimer: Crime trend is derived from annual FBI totals and normalized for reporting. Maps are for visualization and planning support.
      </div>
    </div>

    <!-- RIGHT PANEL (MAPS) -->
    <div id="hscMapsPanel" style="background:#fff;border-radius:18px;padding:30px;border:1px solid #e5e7eb;box-shadow:0 20px 60px rgba(0,0,0,.06);display:flex;flex-direction:column;gap:22px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;color:#111827;">Location Intelligence Maps</h3>
        <div style="font-size:12px;color:#6b7280;">Hybrid • Satellite • Roadmap</div>
      </div>
      <div>
        <div style="font-weight:900;color:#111827;margin:0 0 8px;">Property (Hybrid)</div>
        <div id="map" style="width:100%;height:280px;border-radius:14px;border:1px solid #e5e7eb;"></div>
      </div>
      <div>
        <div style="font-weight:900;color:#111827;margin:0 0 8px;">Crime Density (Satellite)</div>
        <div id="heatmap" style="width:100%;height:280px;border-radius:14px;border:1px solid #e5e7eb;"></div>
      </div>
      <div>
        <div style="font-weight:900;color:#111827;margin:0 0 8px;">Emergency Services (Roadmap)</div>
        <div id="servicesMap" style="width:100%;height:280px;border-radius:14px;border:1px solid #e5e7eb;"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;">
          <div id="responseCard" style="background:#f9fafb;padding:12px;border-radius:14px;border:1px solid #e5e7eb;color:#111827;"></div>
          <div id="lightingCard" style="background:#f9fafb;padding:12px;border-radius:14px;border:1px solid #e5e7eb;color:#111827;"></div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ======== V6.5 SCRIPT (CSP SAFE) ======== -->
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"></script>
<script type="module">
import HSCResults from 'https://api.netcoreleads.com/.netlify/functions/hsresults-v6.5.js';
HSCResults.init({
  apiBase: "https://api.netcoreleads.com/.netlify/functions",
  thankYouUrl: "https://www.homesecurecalculator.com/hscthankyou",
  resultsCanvasIds: {
    risk: "riskChart",
    severity: "severityChart",
    trend: "crimeTrendChart"
  },
  mapElementIds: {
    property: "map",
    heatmap: "heatmap",
    services: "servicesMap"
  },
  uiIds: {
    totals: "totals",
    deviceList: "deviceList",
    deviceCountBadge: "deviceCountBadge",
    riskZoneText: "riskZoneText",
    riskScoreText: "riskScoreText",
    percentileBox: "percentileBox",
    aiExplanation: "aiExplanation",
    contact: "contact",
    downloadPDF: "downloadPDF_exec"
  },
  devices: ["indoorCam","outdoorCam","doorbell","lock","doorSensor","windowSensor","motion","glass","smoke","water","keypad","siren"]
});
</script>
