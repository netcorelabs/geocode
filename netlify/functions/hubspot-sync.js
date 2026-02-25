<!-- =============================
     HSRESULTS (FULL DROP-IN)
     ✅ Maps/Risk/Charts work
     ✅ Executive PDF includes chart images + sections
     ✅ Uploads deliverables to upload-deliverables (deal_id required)
     ✅ HARD-BLOCKS old click handlers (prevents text-only PDF script)
     ✅ Redirects to http://www.homesecurecalculator.com/hscthankyou
============================= -->

<!-- Libraries (load once) -->
<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>

<div style="font-family:Inter,Segoe UI,sans-serif;background:#f4f6fb;padding:60px 20px;min-height:100vh;">
  <div style="max-width:1500px;margin:auto;display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:start;">

    <!-- LEFT PANEL -->
    <div style="background:#ffffff;border-radius:18px;padding:40px;border:1px solid #e5e7eb;box-shadow:0 20px 60px rgba(0,0,0,.06);display:flex;flex-direction:column;gap:18px;">

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
              <div id="deviceCountBadge" style="font-size:12px;font-weight:900;color:#111827;background:#fff;border:1px solid #e5e7eb;border-radius:999px;padding:4px 10px;">0 devices</div>
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

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;">
        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:14px;">
          <div style="font-weight:900;color:#111827;margin-bottom:8px;">Risk Gauge</div>
          <canvas id="riskChart" height="140"></canvas>
        </div>
        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:14px;">
          <div style="font-weight:900;color:#111827;margin-bottom:8px;">Crime Severity</div>
          <canvas id="severityChart" height="140"></canvas>
        </div>
      </div>

      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div style="font-weight:900;color:#111827;">Crime Trend</div>
          <div style="font-size:12px;color:#6b7280;">12-month approximation from FBI totals</div>
        </div>
        <canvas id="crimeTrendChart" height="120"></canvas>
      </div>

      <div id="percentileBox" style="background:#f9fafb;padding:14px;border-radius:14px;border:1px solid #e5e7eb;color:#111827;"></div>
      <div id="aiExplanation" style="background:#f3f4f6;padding:14px;border-radius:14px;border:1px solid #e5e7eb;color:#111827;"></div>

      <button id="downloadPDF" style="padding:14px;border:none;border-radius:14px;background:#111827;color:#fff;font-weight:900;cursor:pointer;">
        Continue to Download PDF →
      </button>

      <div style="font-size:12px;color:#6b7280;line-height:1.45;">
        Disclaimer: Crime trend is derived from annual FBI totals and normalized for reporting. Maps are for visualization and planning support.
      </div>
    </div>

    <!-- RIGHT PANEL (3 MAPS) -->
    <div style="background:#ffffff;border-radius:18px;padding:30px;border:1px solid #e5e7eb;box-shadow:0 20px 60px rgba(0,0,0,.06);display:flex;flex-direction:column;gap:22px;">
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

<script>
(() => {
  // ===== HARD BLOCK OLD RESULTS UPLOADER(S) =====
  // If an older script is attached to #downloadPDF (text-only PDF), this capture handler stops it.
  // We run OUR flow instead.
  if (window.__HSC_RESULTS_FULL_DROPIN_V3__) return;
  window.__HSC_RESULTS_FULL_DROPIN_V3__ = true;

  const API_PRIMARY  = "https://api.netcoreleads.com";
  const API_FALLBACK = "https://hubspotgate.netlify.app";

  const KEY_ENDPOINTS = [
    API_PRIMARY  + "/.netlify/functions/get-google-key",
    API_FALLBACK + "/.netlify/functions/get-google-key",
  ];
  const RISK_ENDPOINTS = [
    API_PRIMARY  + "/.netlify/functions/security-risk",
    API_FALLBACK + "/.netlify/functions/security-risk",
  ];

  const UPLOAD_ENDPOINT = API_PRIMARY + "/.netlify/functions/upload-deliverables";

  // ✅ You asked for HTTP specifically
  const THANKYOU_URL = "http://www.homesecurecalculator.com/hscthankyou";

  const STORAGE_KEY   = "hsc_payload";
  const LS_BACKUP_KEY = "hsc_payload_backup";
  const LEAD_ID_KEY   = "hsc_lead_id";
  const DEAL_ID_KEY   = "hsc_deal_id";
  const INFLOW_LOCK   = "hsc_results_continue_lock_exec_v3";

  const byId = (id) => document.getElementById(id);
  const safeText = (id, v) => { const n = byId(id); if(n) n.textContent = v; };
  const safeHTML = (id, v) => { const n = byId(id); if(n) n.innerHTML = v; };

  function getQueryParam(name){
    try{ return (new URL(window.location.href)).searchParams.get(name) || ""; }
    catch(e){ return ""; }
  }
  function getStoredAny(key){
    try { const s = (sessionStorage.getItem(key)||"").trim(); if(s) return s; } catch(e){}
    try { const s = (localStorage.getItem(key)||"").trim(); if(s) return s; } catch(e){}
    return "";
  }
  function setStored(key, val){
    try { sessionStorage.setItem(key, String(val||"")); } catch(e){}
    try { localStorage.setItem(key, String(val||"")); } catch(e){}
  }
  function clearStored(key){
    try { sessionStorage.removeItem(key); } catch(e){}
    try { localStorage.removeItem(key); } catch(e){}
  }

  function readPayload(){
    try{
      const s = sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(LS_BACKUP_KEY) || "{}";
      return JSON.parse(s);
    }catch{ return {}; }
  }
  function writePayload(payload){
    try{ sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch(e){}
    try{ localStorage.setItem(LS_BACKUP_KEY, JSON.stringify(payload)); } catch(e){}
  }

  function hydratePayload(payload){
    payload = (payload && typeof payload === "object") ? payload : {};
    const qLead  = String(getQueryParam("lead_id")||"").trim();
    const qEmail = String(getQueryParam("email")||"").trim();
    const qDeal  = String(getQueryParam("deal_id")||"").trim();

    const sLead  = getStoredAny(LEAD_ID_KEY);
    const sDeal  = getStoredAny(DEAL_ID_KEY);
    const sEmail = getStoredAny("hsc_email");

    payload.lead_id = String(payload.lead_id || "").trim() || qLead || sLead || "";
    payload.email   = String(payload.email || "").trim()   || qEmail || sEmail || "";
    payload.deal_id = String(payload.deal_id || "").trim() || qDeal  || sDeal  || "";

    if(payload.lead_id) setStored(LEAD_ID_KEY, payload.lead_id);
    if(payload.deal_id) setStored(DEAL_ID_KEY, payload.deal_id);
    if(payload.email)   setStored("hsc_email", payload.email);

    payload.time_line = payload.time_line || payload.timeline || payload.timeLine || "Researching";
    payload.home_ownership = payload.home_ownership || payload.homeOwnership || payload.ownership || "Unknown";
    return payload;
  }

  function currency(n){ return "$" + Math.round(Number(n||0)).toLocaleString(); }

  // ---------- devices ----------
  const DEVICE_DEFS = [
    { key:"indoorCam",  label:"Indoor Cameras" },
    { key:"outdoorCam", label:"Outdoor Cameras" },
    { key:"doorbell",   label:"Video Doorbells" },
    { key:"lock",       label:"Smart Locks" },
    { key:"doorSensor", label:"Door Sensors" },
    { key:"windowSensor", label:"Window Sensors" },
    { key:"motion", label:"Motion Sensors" },
    { key:"glass", label:"Glass Break Sensors" },
    { key:"smoke", label:"Smoke / CO Detectors" },
    { key:"water", label:"Water Leak Sensors" },
    { key:"keypad", label:"Keypads" },
    { key:"siren", label:"Sirens" },
  ];

  function parseSelectedItems(str){
    const lines = [];
    if(!str) return lines;
    String(str).split(",").map(s => s.trim()).filter(Boolean).forEach(item => {
      const m = item.match(/^(.+?)\s*x\s*(\d+)$/i);
      if(m) lines.push({ label: m[1].trim(), qty: Number(m[2]) });
    });
    return lines;
  }

  function buildDeviceLines(payload){
    if(Array.isArray(payload.deviceLines) && payload.deviceLines.length){
      return payload.deviceLines
        .map(d => ({ label: String(d.label||"").trim(), qty: Number(d.qty||0) }))
        .filter(d => d.label && d.qty > 0);
    }
    const fromKeys = [];
    DEVICE_DEFS.forEach(d => {
      const qty = Number(payload[d.key] || 0);
      if(qty > 0) fromKeys.push({ label: d.label, qty });
    });
    if(fromKeys.length) return fromKeys;
    return parseSelectedItems(payload.selectedItems || payload.hsc_devices || payload.deviceSummary || "").filter(x => x.qty > 0);
  }

  function deviceSummaryString(lines){
    if(!lines || !lines.length) return "No devices selected";
    return lines.map(x => `${x.label} x${x.qty}`).join(", ");
  }

  function renderTotalsAndDevices(payload){
    const upfront = Number(payload.upfront ?? payload.hsc_upfront ?? 0);
    const monthly = Number(payload.monthly ?? payload.hsc_monthly ?? 0);

    safeHTML("totals",
      "<div style='display:flex;justify-content:space-between;'><span style='color:#6b7280;font-weight:800;'>Upfront</span><span style='font-weight:900;'>" + currency(upfront) + "</span></div>" +
      "<div style='display:flex;justify-content:space-between;margin-top:6px;'><span style='color:#6b7280;font-weight:800;'>Monthly</span><span style='font-weight:900;'>" + currency(monthly) + "/mo</span></div>"
    );

    const lines = buildDeviceLines(payload);
    const deviceCount = lines.reduce((a,b)=>a + (Number(b.qty)||0), 0);
    safeText("deviceCountBadge", deviceCount + " devices");

    payload.deviceLines = lines;
    payload.deviceSummary = deviceSummaryString(lines);
    payload.hsc_devices = payload.deviceSummary;
    payload.hsc_monthly = monthly;
    payload.hsc_upfront = upfront;

    const listEl = byId("deviceList");
    if(listEl){
      listEl.innerHTML = lines.length
        ? lines.map(d => (
            "<div style='display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px dashed #e5e7eb;'>" +
              "<div style='color:#111827;font-weight:800;font-size:13px;'>" + d.label + "</div>" +
              "<div style='color:#6b7280;font-weight:900;font-size:13px;'>x" + d.qty + "</div>" +
            "</div>"
          )).join("")
        : "<div style='color:#6b7280;font-size:13px;font-weight:800;'>No devices selected</div>";
    }

    writePayload(payload);
  }

  // ---------- fetch helpers ----------
  async function readText(res){ try { return await res.text(); } catch { return ""; } }

  async function fetchWithTimeout(url, options={}, ms=25000){
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try{
      return await fetch(url, { ...options, signal: ctrl.signal, cache:"no-store" });
    } finally {
      clearTimeout(t);
    }
  }

  async function fetchJsonWithFallback(urls, options){
    let lastErr = "";
    for (const u of urls){
      try{
        const r = await fetchWithTimeout(u, options, 25000);
        const t = await readText(r);
        let j = null;
        try{ j = t ? JSON.parse(t) : null; }catch(e){ j = null; }
        if(r.ok) return { ok:true, url:u, json:j, text:t, status:r.status };
        lastErr = `${u} -> ${r.status} ${t}`;
      }catch(e){
        lastErr = `${u} -> ${String(e?.message || e)}`;
      }
    }
    return { ok:false, error:lastErr };
  }

  // ---------- maps loader ----------
  async function getGoogleKey(){
    const r = await fetchJsonWithFallback(KEY_ENDPOINTS, { cache:"no-store" });
    if(!r.ok) throw new Error("Google key fetch failed: " + r.error);
    if(!r.json?.key) throw new Error("Google key missing in response");
    return r.json.key;
  }

  function loadGoogleMapsScript(key){
    return new Promise((resolve, reject) => {
      if (window.google && window.google.maps) return resolve();
      if (window.__HSC_MAPS_LOADING) {
        window.__HSC_MAPS_LOADING.then(resolve).catch(reject);
        return;
      }
      window.__HSC_MAPS_LOADING = new Promise((res, rej) => {
        window.__hsc_maps_cb = () => res();
        const s = document.createElement("script");
        s.async = true; s.defer = true;
        s.onerror = () => rej(new Error("Google Maps JS failed to load"));
        s.src =
          "https://maps.googleapis.com/maps/api/js" +
          "?key=" + encodeURIComponent(key) +
          "&v=weekly" +
          "&libraries=places,geometry,visualization" +
          "&loading=async" +
          "&callback=__hsc_maps_cb";
        document.head.appendChild(s);
      });
      window.__HSC_MAPS_LOADING.then(resolve).catch(reject);
    });
  }

  function geocodeAddress(address){
    return new Promise((resolve, reject) => {
      if(!google?.maps?.Geocoder) return reject(new Error("Geocoder unavailable"));
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ address }, (results, status) => {
        if(status === "OK" && results && results[0]) resolve(results[0]);
        else reject(new Error("Geocode failed: " + status));
      });
    });
  }

  function setHubSpotAddressFields(payload, geo){
    const comps = geo.address_components || [];
    const pick = (type, mode="long_name") =>
      comps.find(c => (c.types||[]).includes(type))?.[mode] || "";

    const streetNumber = pick("street_number","long_name");
    const route        = pick("route","long_name");
    const city =
      pick("locality","long_name") ||
      pick("postal_town","long_name") ||
      pick("sublocality","long_name") ||
      pick("administrative_area_level_2","long_name") || "";
    const stateCode  = pick("administrative_area_level_1","short_name") || "";
    const postalCode = pick("postal_code","long_name") || "";
    const country    = pick("country","long_name") || "";

    payload.street_address = (streetNumber + " " + route).trim();
    payload.city = city;
    payload.state_code = stateCode;
    payload.postal_code = postalCode;
    payload.country_region = country;

    payload.hsc_property_address = geo.formatted_address || payload.hsc_property_address || payload.address || "";
    payload.address = payload.hsc_property_address;

    writePayload(payload);
  }

  function buildBestAddressString(payload){
    const full = String(payload.hsc_property_address || payload.address || payload.geo?.formatted || "").trim();
    if(full && full.toLowerCase() !== "address not selected") return full;

    const street = String(payload.street_address || "").trim();
    const city = String(payload.city || "").trim();
    const st = String(payload.state_code || payload.state || "").trim();
    const zip = String(payload.postal_code || payload.zip || "").trim();

    return [street, city, st, zip].filter(Boolean).join(", ").trim();
  }

  async function fetchRisk({ loc, zip, state, payload, responseMinutes }){
    const urls = RISK_ENDPOINTS.map(u =>
      u +
      `?lat=${encodeURIComponent(loc.lat())}` +
      `&lng=${encodeURIComponent(loc.lng())}` +
      `&zip=${encodeURIComponent(zip || "")}` +
      `&state=${encodeURIComponent(state || "")}` +
      `&indoorCam=${encodeURIComponent(payload.indoorCam||0)}` +
      `&outdoorCam=${encodeURIComponent(payload.outdoorCam||0)}` +
      `&doorbell=${encodeURIComponent(payload.doorbell||0)}` +
      `&lock=${encodeURIComponent(payload.lock||0)}` +
      `&monthly=${encodeURIComponent(payload.monthly||0)}` +
      `&upfront=${encodeURIComponent(payload.upfront||0)}` +
      (responseMinutes ? `&responseMinutes=${encodeURIComponent(responseMinutes)}` : "")
    );
    const r = await fetchJsonWithFallback(urls, { cache:"no-store" });
    if(!r.ok) throw new Error("Risk API failed: " + r.error);
    return r.json;
  }

  // ---------- charts ----------
  let chartRisk=null, chartSeverity=null, chartTrend=null;

  function renderChartsFromRisk(risk){
    const riskScore  = risk?.scoring?.riskScore ?? 50;
    const zone       = risk?.scoring?.zone ?? "Moderate";
    const zoneColor  = risk?.scoring?.zoneColor ?? "#111827";

    safeText("riskZoneText", zone);
    safeText("riskScoreText", riskScore + "/100");

    const box = byId("riskZoneBox");
    if(box){
      box.style.borderColor = zoneColor;
      box.style.background = zoneColor + "14";
    }

    if(chartRisk) chartRisk.destroy();
    if(chartSeverity) chartSeverity.destroy();
    if(chartTrend) chartTrend.destroy();

    chartRisk = new Chart(byId("riskChart"),{
      type:"doughnut",
      data:{datasets:[{ data:[riskScore, 100-riskScore], backgroundColor:[zoneColor,"#e5e7eb"], borderWidth:0 }]},
      options:{cutout:"72%",plugins:{legend:{display:false}},animation:false}
    });

    chartSeverity = new Chart(byId("severityChart"),{
      type:"bar",
      data:{ labels:["Violent","Property","Crime Index"], datasets:[{ data:[ risk?.crime?.violent||0, risk?.crime?.property||0, risk?.scoring?.crimeIndex||0 ] }]},
      options:{plugins:{legend:{display:false}},scales:{x:{grid:{display:false}},y:{grid:{display:false}}},animation:false}
    });

    const trend = (risk?.crime?.trend12Months || []).slice(0,12);
    chartTrend = new Chart(byId("crimeTrendChart"),{
      type:"line",
      data:{ labels:["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"], datasets:[{data:trend, borderWidth:2, pointRadius:2, fill:false}]},
      options:{plugins:{legend:{display:false}},scales:{x:{grid:{display:false}},y:{grid:{display:false}}},animation:false}
    });

    const usP = risk?.scoring?.percentiles?.us ?? 50;
    const stP = risk?.scoring?.percentiles?.state ?? 50;
    const inc = risk?.demographics?.medianIncome;

    safeHTML("percentileBox",
      "<div style='font-weight:900;margin-bottom:6px;'>Risk Comparison</div>" +
      "<div style='display:flex;justify-content:space-between;'><span style='color:#6b7280;font-weight:800;'>US Percentile</span><span style='font-weight:900;'>" + usP + "th</span></div>" +
      "<div style='display:flex;justify-content:space-between;margin-top:6px;'><span style='color:#6b7280;font-weight:800;'>State Percentile</span><span style='font-weight:900;'>" + stP + "th</span></div>" +
      "<div style='display:flex;justify-content:space-between;margin-top:6px;'><span style='color:#6b7280;font-weight:800;'>Median Income (ZIP)</span><span style='font-weight:900;'>" + (inc ? "$"+Math.round(inc).toLocaleString() : "—") + "</span></div>"
    );

    safeHTML("aiExplanation",
      "<div style='font-weight:900;margin-bottom:6px;'>AI Risk Explanation</div>" +
      "<div style='line-height:1.45;'>" + (risk?.ui?.headline || "Risk reflects crime, response modeling, exposure, and mitigation from your configuration.") + "</div>"
    );
  }

  // ---------- heatmap helper ----------
  function buildHeatPoints(center, intensity){
    const pts = [];
    const count = Math.round(80 + intensity * 1.6);
    for(let i=0;i<count;i++){
      pts.push({
        location: new google.maps.LatLng(
          center.lat() + (Math.random()-0.5)/220,
          center.lng() + (Math.random()-0.5)/220
        ),
        weight: 1 + Math.random() * (1 + intensity/25)
      });
    }
    return pts;
  }
  function renderHeatLayer(map, center, crimeIndex){
    const HeatmapLayer = google.maps.visualization && google.maps.visualization.HeatmapLayer;
    if(HeatmapLayer){
      const layer = new HeatmapLayer({ data: buildHeatPoints(center, crimeIndex), radius: 28 });
      layer.setMap(map);
      return;
    }
    const circles = Math.round(18 + crimeIndex/4);
    for(let i=0;i<circles;i++){
      new google.maps.Circle({
        strokeOpacity:0,
        fillColor:"#ef4444",
        fillOpacity:0.14,
        map,
        center:{
          lat:center.lat() + (Math.random()-0.5)/250,
          lng:center.lng() + (Math.random()-0.5)/250
        },
        radius: 80 + Math.random()*240
      });
    }
  }

  // ---------- run (maps + risk) ----------
  let __REPORT_READY = false;

  async function run(){
    let payload = hydratePayload(readPayload());

    if(!payload.email){
      safeText("statusText","Error");
      safeText("statusSub","Missing email. Restart the flow.");
      return;
    }

    safeHTML("contact",
      "<div style='font-weight:900;'>" + (payload.firstname||"") + " " + (payload.lastname||"") + "</div>" +
      "<div style='color:#6b7280;font-weight:700;'>" + (payload.email||"") + "</div>" +
      "<div style='color:#6b7280;font-weight:700;'>" + (payload.phone||"") + "</div>" +
      "<div style='margin-top:6px;color:#111827;font-weight:800;'>" + (payload.address||payload.geo?.formatted||payload.hsc_property_address||"") + "</div>"
    );

    renderTotalsAndDevices(payload);

    const address = buildBestAddressString(payload);
    if(!address){
      safeText("statusText","Error");
      safeText("statusSub","Missing address from step 1");
      return;
    }

    safeText("statusText","Loading…");
    safeText("statusSub","Loading Google Maps…");

    const key = await getGoogleKey();
    await loadGoogleMapsScript(key);

    safeText("statusSub","Geocoding address…");
    const geo = await geocodeAddress(address);
    const loc = geo.geometry.location;

    const comps = geo.address_components || [];
    const zip = comps.find(c=>c.types.includes("postal_code"))?.long_name || payload.zip || payload.postal_code || "";
    const state = comps.find(c=>c.types.includes("administrative_area_level_1"))?.short_name || payload.state_code || payload.state || "";

    setHubSpotAddressFields(payload, geo);

    payload.geo = payload.geo || {};
    payload.geo.formatted = payload.hsc_property_address || geo.formatted_address || address;
    payload.geo.lat = loc.lat();
    payload.geo.lng = loc.lng();
    payload.geo.zip = zip;
    payload.geo.state = state;
    writePayload(payload);

    // services map
    safeText("statusSub","Computing nearby emergency services…");
    const servicesMap = new google.maps.Map(byId("servicesMap"),{
      center:loc, zoom:14, mapTypeId:"roadmap", mapTypeControl:false, streetViewControl:false
    });
    new google.maps.Marker({ position: loc, map: servicesMap });

    const service = new google.maps.places.PlacesService(servicesMap);
    let bestMeters = Infinity;

    const types = ["police","fire_station","hospital"];
    const doSearch = (type) => new Promise((resolve) => {
      service.nearbySearch({ location: loc, radius: 3500, type }, (res, status) => {
        if(status === google.maps.places.PlacesServiceStatus.OK && Array.isArray(res)){
          res.slice(0, 8).forEach(place => {
            const pos = place.geometry.location;
            new google.maps.Marker({ position: pos, map: servicesMap });
            if(google.maps.geometry?.spherical?.computeDistanceBetween){
              const d = google.maps.geometry.spherical.computeDistanceBetween(loc, pos);
              if(d < bestMeters) bestMeters = d;
            }
          });
        }
        resolve();
      });
    });

    await Promise.all(types.map(doSearch));

    const responseMinutes = (bestMeters !== Infinity)
      ? Math.max(1, Math.round((bestMeters/1000)/0.8))
      : null;

    safeHTML("responseCard",
      "<div style='font-weight:900;margin-bottom:4px;'>Emergency Response Estimate</div>" +
      "<div style='font-size:22px;font-weight:900;'>" + (responseMinutes ? (responseMinutes + " min") : "—") + "</div>" +
      "<div style='color:#6b7280;font-size:12px;margin-top:4px;'>Distance-based estimate from nearest facility.</div>"
    );

    // risk
    safeText("statusSub","Fetching crime + scoring model…");
    let risk = null;
    try{
      risk = await fetchRisk({ loc, zip, state, payload, responseMinutes });
      if(risk?.scoring && Number.isFinite(Number(risk.scoring.riskScore))){
        payload.hsc_risk_score = Math.round(Number(risk.scoring.riskScore));
        writePayload(payload);
      }
    }catch(e){
      risk = {
        ok:true,
        scoring:{riskScore:50,zone:"Moderate",zoneColor:"#111827",crimeIndex:50,responseRisk:40,exposureScore:55,percentiles:{us:50,state:50}},
        crime:{violent:0,property:0,trend12Months:[10,12,11,13,14,13,12,11,12,13,12,11]},
        demographics:{medianIncome:null},
        ui:{headline:"Risk data unavailable; showing baseline report."}
      };
    }

    window.__HSC_REPORT = { payload, risk, geo: payload.geo, responseMinutes };
    window.__HSC_REPORT_exists__ = true;

    renderChartsFromRisk(risk);

    const exposure = risk?.scoring?.exposureScore ?? 55;
    safeHTML("lightingCard",
      "<div style='font-weight:900;margin-bottom:4px;'>Security Exposure Score</div>" +
      "<div style='font-size:22px;font-weight:900;'>" + exposure + "/100</div>" +
      "<div style='color:#6b7280;font-size:12px;margin-top:4px;'>Derived from model inputs (location + configuration).</div>"
    );

    // maps
    const map1 = new google.maps.Map(byId("map"),{
      center:loc, zoom:16, mapTypeId:"hybrid", mapTypeControl:false, streetViewControl:false
    });
    new google.maps.Marker({ position: loc, map: map1 });

    const map2 = new google.maps.Map(byId("heatmap"),{
      center:loc, zoom:15, mapTypeId:"satellite", mapTypeControl:false, streetViewControl:false
    });
    renderHeatLayer(map2, loc, risk?.scoring?.crimeIndex ?? 50);

    safeText("statusText","Ready");
    safeText("statusSub","Click Continue to generate your Executive PDF + upload deliverables.");
    __REPORT_READY = true;
  }

  // ---------- CSV helpers ----------
  function escCsv(v){
    const s = String(v ?? "");
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  }
  function buildCsv(payload){
    const headers = [
      "lead_id","deal_id","firstname","lastname","email","phone",
      "street_address","city","state","zip","country",
      "hsc_property_address","home_ownership","time_line",
      "hsc_risk_score","hsc_devices","hsc_monthly","hsc_upfront"
    ];
    const row = [
      payload.lead_id || "",
      payload.deal_id || "",
      payload.firstname||"", payload.lastname||"", payload.email||"", payload.phone||"",
      payload.street_address||payload.address||"",
      payload.city||"", payload.state_code||payload.state||"", payload.postal_code||payload.zip||"",
      payload.country_region||"",
      payload.hsc_property_address||payload.address||"",
      payload.home_ownership||"",
      payload.time_line||"",
      payload.hsc_risk_score ?? "",
      payload.hsc_devices||payload.deviceSummary||payload.selectedItems||"",
      payload.hsc_monthly ?? payload.monthly ?? "",
      payload.hsc_upfront ?? payload.upfront ?? "",
    ];
    return headers.map(escCsv).join(",") + "\n" + row.map(escCsv).join(",") + "\n";
  }

  function blobToBase64(blob){
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || "").split(",")[1] || "");
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  function canvasPng(id){
    const c = byId(id);
    if(!c || !c.toDataURL) return "";
    try { return c.toDataURL("image/png", 1.0); } catch(e){ return ""; }
  }

  function clamp(n,min,max){ n=Number(n); if(!Number.isFinite(n)) return min; return Math.max(min, Math.min(max, n)); }
  function fmtDate(){
    const dt = new Date();
    const pad = (x)=>String(x).padStart(2,"0");
    return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  }
  function redactedLoc(payload){
    const city = String(payload.city || "").trim();
    const st = String(payload.state_code || payload.state || "").trim();
    const zip = String(payload.postal_code || payload.zip || "").trim();
    const zip3 = (zip.match(/\b(\d{3})\d{2}\b/)||[])[1] || "";
    const base = [city, st].filter(Boolean).join(", ");
    return base + (zip3 ? ` ${zip3}xx` : "");
  }
  function recommendationsFromScore(score){
    const s = clamp(score,0,100);
    if(s >= 75){
      return [
        "Prioritize perimeter coverage: doorbell + outdoor camera visibility at all entry points.",
        "Add intrusion sensors on all exterior doors and ground-floor windows.",
        "Enable professional monitoring for faster dispatch coordination.",
        "Improve exterior lighting and visibility (driveway + rear access)."
      ];
    }
    if(s >= 55){
      return [
        "Ensure doorbell + at least one outdoor camera covers primary entry points.",
        "Add door sensors on exterior doors and motion sensors for main hallways.",
        "Consider professional monitoring for higher confidence response.",
        "Review blind spots and add lighting to reduce concealment areas."
      ];
    }
    return [
      "Maintain baseline coverage for key entries (doorbell + one outdoor camera).",
      "Add door sensors and one motion sensor for interior alerting.",
      "Use self-monitoring or pro monitoring based on travel frequency and preferences.",
      "Review placement quarterly and keep firmware/app settings updated."
    ];
  }

  // ---------- Executive PDF builder (this is the one you want) ----------
  async function buildExecutivePdfBlob(payload){
    const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
    if(!jsPDFCtor) throw new Error("jsPDF not loaded");

    const report = window.__HSC_REPORT || {};
    const risk = report.risk || {};
    const responseMinutes = report.responseMinutes ?? null;

    const riskScore = Math.round(Number(payload.hsc_risk_score ?? risk?.scoring?.riskScore ?? 0));
    const zone = String(risk?.scoring?.zone || "—");
    const crimeIndex = Number(risk?.scoring?.crimeIndex ?? "");
    const exposureScore = Number(risk?.scoring?.exposureScore ?? "");
    const usP = Number(risk?.scoring?.percentiles?.us ?? "");
    const stP = Number(risk?.scoring?.percentiles?.state ?? "");

    const upfront = Number(payload.hsc_upfront ?? payload.upfront ?? 0);
    const monthly = Number(payload.hsc_monthly ?? payload.monthly ?? 0);

    const deviceLines = Array.isArray(payload.deviceLines) ? payload.deviceLines : buildDeviceLines(payload);

    // Chart canvases -> PNG
    const imgRisk  = canvasPng("riskChart");
    const imgSev   = canvasPng("severityChart");
    const imgTrend = canvasPng("crimeTrendChart");

    const doc = new jsPDFCtor({ unit:"pt", format:"letter" });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 48;

    const headerBar = (title) => {
      doc.setFillColor(17,24,39);
      doc.rect(0, 0, pageW, 72, "F");
      doc.setTextColor(255,255,255);
      doc.setFont("helvetica","bold"); doc.setFontSize(16);
      doc.text(title, margin, 44);
      doc.setFont("helvetica","normal"); doc.setFontSize(9);
      doc.setTextColor(226,232,240);
      doc.text(`Generated: ${fmtDate()}`, pageW - margin, 46, { align:"right" });
      doc.setTextColor(20);
    };

    const section = (title, y) => {
      doc.setFillColor(245,246,251);
      doc.setDrawColor(229,231,235);
      doc.roundedRect(margin, y, pageW - margin*2, 26, 8, 8, "FD");
      doc.setFont("helvetica","bold"); doc.setFontSize(11);
      doc.setTextColor(17,24,39);
      doc.text(title, margin + 12, y + 18);
      doc.setTextColor(20);
      return y + 38;
    };

    const kv = (x, y, k, v) => {
      doc.setFont("helvetica","bold"); doc.setFontSize(10);
      doc.text(String(k||""), x, y);
      doc.setFont("helvetica","normal");
      doc.text(String(v ?? "—"), x + 140, y, { maxWidth: (pageW - margin) - (x + 140) });
      return y + 14;
    };

    // Page 1
    headerBar("Executive Home Security Risk Report");
    let y = 92;

    // Summary cards
    const cardW = (pageW - margin*2 - 14) / 2;
    const cardH = 92;

    const card = (x, y0, title, big, lines) => {
      doc.setDrawColor(229,231,235);
      doc.setFillColor(255,255,255);
      doc.roundedRect(x, y0, cardW, cardH, 12, 12, "FD");
      doc.setFont("helvetica","bold"); doc.setFontSize(9);
      doc.setTextColor(107,114,128);
      doc.text(title, x+14, y0+20);
      doc.setTextColor(17,24,39);
      doc.setFont("helvetica","bold"); doc.setFontSize(18);
      doc.text(String(big || "—"), x+14, y0+46);
      doc.setFont("helvetica","normal"); doc.setFontSize(9);
      doc.setTextColor(75,85,99);
      let yy = y0 + 62;
      (lines||[]).forEach(line => { doc.text(String(line||""), x+14, yy); yy += 12; });
      doc.setTextColor(20);
    };

    card(margin, y, "Risk Score", `${riskScore}/100`, [
      `Zone: ${zone}`,
      `Crime Index: ${Number.isFinite(crimeIndex) ? Math.round(crimeIndex) : "—"}`,
      `Response Est.: ${responseMinutes ? responseMinutes + " min" : "—"}`
    ]);

    card(margin + cardW + 14, y, "Assessment", redactedLoc(payload) || "Location", [
      `Deal ID: ${payload.deal_id || "—"}`,
      `Lead ID: ${payload.lead_id || "—"}`,
      `Upfront: ${currency(upfront)} • Monthly: ${currency(monthly)}/mo`
    ]);

    y += cardH + 16;

    y = section("Client & Property", y);
    const name = `${payload.firstname||""} ${payload.lastname||""}`.trim() || "—";
    const addr = String(payload.hsc_property_address || payload.address || payload.geo?.formatted || "—");
    y = kv(margin, y, "Name", name);
    y = kv(margin, y, "Email", payload.email || "—");
    y = kv(margin, y, "Phone", payload.phone || "—");
    y = kv(margin, y, "Address", addr);

    y += 8;
    y = section("Charts (from Results Page)", y);

    const imgH = 150;
    const imgW = (pageW - margin*2 - 14) / 2;

    if (imgRisk) doc.addImage(imgRisk, "PNG", margin, y, imgW, imgH, undefined, "FAST");
    else { doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.text("Risk chart unavailable", margin, y + 20); }

    if (imgSev) doc.addImage(imgSev, "PNG", margin + imgW + 14, y, imgW, imgH, undefined, "FAST");
    else { doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.text("Severity chart unavailable", margin + imgW + 14, y + 20); }

    y += imgH + 14;

    const trendH = 150;
    if (imgTrend) doc.addImage(imgTrend, "PNG", margin, y, pageW - margin*2, trendH, undefined, "FAST");
    else { doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.text("Trend chart unavailable", margin, y + 20); }

    // Page 2
    doc.addPage();
    headerBar("Configuration & Recommendations");
    y = 92;

    y = section("Risk & Benchmarks", y);
    y = kv(margin, y, "Risk Zone", zone);
    y = kv(margin, y, "Risk Score", `${riskScore}/100`);
    y = kv(margin, y, "US Percentile", Number.isFinite(usP) ? `${Math.round(usP)}th` : "—");
    y = kv(margin, y, "State Percentile", Number.isFinite(stP) ? `${Math.round(stP)}th` : "—");
    y = kv(margin, y, "Exposure Score", Number.isFinite(exposureScore) ? `${Math.round(exposureScore)}/100` : "—");
    y = kv(margin, y, "Emergency Response Estimate", responseMinutes ? `${responseMinutes} min` : "—");

    y += 10;
    y = section("Totals & Selections", y);
    y = kv(margin, y, "Upfront Total", currency(upfront));
    y = kv(margin, y, "Monthly Total", `${currency(monthly)}/mo`);
    y = kv(margin, y, "Home Ownership", payload.home_ownership || "Unknown");
    y = kv(margin, y, "Timeline", payload.time_line || "Researching");

    y += 10;
    y = section("Device Breakdown", y);

    doc.setDrawColor(229,231,235);
    doc.setFillColor(249,250,251);
    doc.rect(margin, y, pageW - margin*2, 22, "FD");
    doc.setFont("helvetica","bold"); doc.setFontSize(10);
    doc.setTextColor(17,24,39);
    doc.text("Device", margin+10, y+15);
    doc.text("Qty", pageW - margin - 10, y+15, { align:"right" });
    doc.setTextColor(20);
    y += 30;

    doc.setFont("helvetica","normal"); doc.setFontSize(10);
    const rows = deviceLines.length ? deviceLines : [{ label: "No devices selected", qty: 0 }];

    rows.forEach(r => {
      if (y > pageH - 140) {
        doc.addPage();
        headerBar("Configuration & Recommendations");
        y = 92;
      }
      doc.setDrawColor(240);
      doc.line(margin, y, pageW - margin, y);
      y += 14;
      doc.text(String(r.label || "—"), margin+10, y);
      doc.text(String(r.qty ?? "—"), pageW - margin - 10, y, { align:"right" });
      y += 12;
    });

    y += 10;
    y = section("Recommendations", y);
    doc.setFont("helvetica","normal"); doc.setFontSize(10);

    const recs = recommendationsFromScore(riskScore);
    recs.forEach(item => {
      const lines = doc.splitTextToSize("• " + String(item||""), pageW - margin*2);
      if (y + lines.length*14 > pageH - 90) {
        doc.addPage();
        headerBar("Configuration & Recommendations");
        y = 92;
      }
      doc.text(lines, margin, y);
      y += lines.length * 14 + 4;
    });

    doc.setFont("helvetica","normal"); doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text("Notes: Crime trend derived from annual FBI totals and normalized for reporting. For planning purposes only.", margin, pageH - 32);
    doc.setTextColor(20);

    return doc.output("blob");
  }

  // expose for debugging / optional module split
  window.HSC_BUILD_EXEC_PDF_BLOB = buildExecutivePdfBlob;

  async function uploadDeliverables(leadId, dealId, pdfB64, csvText){
    return fetchJsonWithFallback([UPLOAD_ENDPOINT], {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ lead_id: leadId, deal_id: dealId, pdf_base64: pdfB64, csv_text: csvText })
    });
  }

  async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
  async function uploadWithRetries(args){
    const delays = [0, 700, 1400, 2800];
    let last = null;
    for(const d of delays){
      if(d) await sleep(d);
      last = await uploadDeliverables(args.leadId, args.dealId, args.pdfB64, args.csvText);
      if(last.ok) return last;
    }
    return last;
  }

  // ---------- Continue handler (upload + redirect) ----------
  async function onContinue(){
    if(getStoredAny(INFLOW_LOCK) === "1") return;
    setStored(INFLOW_LOCK, "1");

    const btn = byId("downloadPDF");
    if(btn){
      btn.disabled = true;
      btn.style.opacity = "0.85";
      btn.style.cursor = "not-allowed";
    }

    if(!__REPORT_READY || !window.__HSC_REPORT?.payload){
      safeText("statusText","Loading…");
      safeText("statusSub","Report is still loading. Please wait 2–3 seconds and click again.");
      clearStored(INFLOW_LOCK);
      if(btn){ btn.disabled=false; btn.style.opacity="1"; btn.style.cursor="pointer"; }
      return;
    }

    // Give charts 2 frames so canvas pixels exist before toDataURL()
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    let payload = hydratePayload(readPayload());
    writePayload(payload);

    if(!payload.lead_id || !payload.email){
      safeText("statusText","Error");
      safeText("statusSub","Missing lead_id or email. Restart the flow.");
      clearStored(INFLOW_LOCK);
      if(btn){ btn.disabled=false; btn.style.opacity="1"; btn.style.cursor="pointer"; }
      return;
    }

    if(!payload.deal_id){
      safeText("statusText","Error");
      safeText("statusSub","Missing deal_id. Deal must be created on calculator before coming here.");
      clearStored(INFLOW_LOCK);
      if(btn){ btn.disabled=false; btn.style.opacity="1"; btn.style.cursor="pointer"; }
      alert("Missing deal_id.\n\nYour calculator step must create the deal and pass deal_id to results.");
      return;
    }

    const leadId = payload.lead_id;
    const dealId = payload.deal_id;

    const UP_FLAG = "hsc_deliverables_uploaded_exec_" + leadId + "_" + dealId;
    const already = (function(){ try { return sessionStorage.getItem(UP_FLAG) === "1"; } catch(e){ return false; } })();

    if(!already){
      try { sessionStorage.setItem(UP_FLAG, "1"); } catch(e){}

      safeText("statusText","Working…");
      safeText("statusSub","Generating Executive PDF + CSV…");

      let pdfBlob, pdfB64;
      try{
        pdfBlob = await buildExecutivePdfBlob(payload);
        pdfB64  = await blobToBase64(pdfBlob);
      }catch(e){
        try { sessionStorage.removeItem(UP_FLAG); } catch(err){}
        safeText("statusText","Error");
        safeText("statusSub","Executive PDF generation failed.");
        clearStored(INFLOW_LOCK);
        if(btn){ btn.disabled=false; btn.style.opacity="1"; btn.style.cursor="pointer"; }
        alert("PDF generation failed:\n" + String(e?.message || e));
        return;
      }

      const csvText = buildCsv(payload);

      safeText("statusSub","Uploading deliverables…");

      const up = await uploadWithRetries({ leadId, dealId, pdfB64, csvText });
      if(!up.ok){
        try { sessionStorage.removeItem(UP_FLAG); } catch(err){}
        safeText("statusText","Error");
        safeText("statusSub", up.error || up.text || "Upload failed");
        clearStored(INFLOW_LOCK);
        if(btn){ btn.disabled=false; btn.style.opacity="1"; btn.style.cursor="pointer"; }
        alert("Upload failed:\n" + (up.error || up.text || "Unknown"));
        return;
      }
    }

    safeText("statusSub","Redirecting…");
    window.location.href =
      THANKYOU_URL +
      "?lead_id=" + encodeURIComponent(leadId) +
      "&deal_id=" + encodeURIComponent(dealId) +
      "&email=" + encodeURIComponent(payload.email || "");
  }

  // ====== THE KEY PART: stop old scripts from firing ======
  // Capture click at the document level BEFORE it reaches the button.
  document.addEventListener("click", (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest("#downloadPDF") : null;
    if(!btn) return;

    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();

    onContinue().catch(e => {
      console.error("Continue error:", e);
      safeText("statusText","Error");
      safeText("statusSub", String(e?.message || e));
      clearStored(INFLOW_LOCK);
      try { btn.disabled=false; btn.style.opacity="1"; btn.style.cursor="pointer"; } catch(_){}
    });
  }, true);

  // Also clone the button once DOM exists (wipes existing listeners)
  document.addEventListener("DOMContentLoaded", async () => {
    const btn = byId("downloadPDF");
    if(btn && btn.parentNode){
      const clone = btn.cloneNode(true);
      btn.parentNode.replaceChild(clone, btn);
    }

    console.info("[HSRESULTS] Full Drop-In V3 loaded (exec PDF + upload + redirect).");

    try{
      await run();
    }catch(e){
      console.error("HSRESULTS init error:", e);
      safeText("statusText","Error");
      safeText("statusSub", String(e?.message || e));
    }
  });
})();
</script>
