<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Smart Home Security Calculator</title>

<style>
:root {
  --primary:#0b1c2d;
  --accent:#2563eb;
  --bg:#f7f9fb;
  --text:#1f2937;
  --muted:#6b7280;
  --radius:12px;
  --border:#e5e7eb;
  --card:#ffffff;
}

body { margin:0; font-family:Inter,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); }
.calculator { max-width:1200px; margin:auto; padding:28px 18px 54px; }

.topbar{
  display:flex; justify-content:space-between; align-items:flex-start; gap:16px;
  padding:16px 18px; background:var(--card); border:1px solid var(--border); border-radius:16px;
}

.brand .kicker{ color:var(--accent); font-weight:900; letter-spacing:.14em; text-transform:uppercase; font-size:12px; }
.brand h1{ margin:0; font-size:28px; line-height:1.15; color:var(--primary); }
.brand .sub{ margin:6px 0 0; color:var(--muted); font-size:14px; }

.addrCard{ min-width:320px; background:#f9fafb; border:1px solid var(--border); border-radius:14px; padding:12px 14px; }
.addrCard .label{ color:var(--muted); font-size:12px; font-weight:800; }
.addrCard .addr{ margin-top:6px; font-weight:900; color:#4b5563; }

.section{ margin-top:22px; background:var(--card); border:1px solid var(--border); border-radius:16px; padding:18px; }
.section h2{ margin:0 0 12px; font-size:18px; font-weight:900; }

.grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px; }

label{ font-size:13px; font-weight:800; }
select,input{ width:100%; padding:12px; border-radius:var(--radius); border:1px solid #d1d5db; }

.totals{ margin-top:22px; background:var(--primary); color:#fff; padding:18px; border-radius:16px; }
.totalRow{ display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,.10); }
.totalRow:last-child{ border-bottom:none; }
.totalRow span{ color:#dbeafe; font-weight:800; font-size:13px; }
.totalRow b{ color:#fff; font-weight:900; font-size:18px; }

#device-summary{
  margin-top:10px; font-size:12px; color:#e0f2fe; line-height:1.45;
  max-height:86px; overflow:auto; padding-top:10px; border-top:1px dashed rgba(255,255,255,.18);
}

button{
  width:100%; padding:14px; margin-top:16px; background:var(--accent); color:#fff;
  border:none; border-radius:14px; font-size:16px; font-weight:900; cursor:pointer;
}
button:disabled{ opacity:.7; cursor:not-allowed; }
</style>
</head>

<body>
<div class="calculator">

  <div class="topbar">
    <div class="brand">
      <div class="kicker">System Builder</div>
      <h1>Smart Home Security Cost Estimator</h1>
      <p class="sub">Your selections flow directly into your Executive Risk Report.</p>
    </div>
    <div class="addrCard">
      <div class="label">Property</div>
      <div class="addr" id="addrLine">Loading…</div>
    </div>
  </div>

  <div class="section">
    <h2>System Configuration</h2>
    <div class="grid">
      <div>
        <label>Package</label>
        <select id="tier"></select>
      </div>
      <div>
        <label>Installation</label>
        <select id="install"></select>
      </div>
      <div>
        <label>Monitoring</label>
        <select id="monitoring"></select>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Devices</h2>
    <div class="grid">
      <div><label>Indoor Cameras</label><input id="indoorCam" type="number" min="0" value="0"></div>
      <div><label>Outdoor Cameras</label><input id="outdoorCam" type="number" min="0" value="0"></div>
      <div><label>Video Doorbells</label><input id="doorbell" type="number" min="0" value="0"></div>
      <div><label>Smart Locks</label><input id="lock" type="number" min="0" value="0"></div>
    </div>
  </div>

  <div class="totals">
    <div class="totalRow"><span>Upfront</span><b id="upfront">$0</b></div>
    <div class="totalRow"><span>Monthly</span><b id="monthly">$0/mo</b></div>
    <div id="device-summary">No devices selected</div>
  </div>

  <button id="submit-btn">Continue to Executive Risk Report →</button>
</div>

<script>
(() => {
  /* =========================
     CONFIG
  ========================= */
  const STORAGE_KEY = "hsc_payload";
  const LS_BACKUP_KEY = "hsc_payload_backup";

  const RESULTS_URL = "https://www.homesecurecalculator.com/hscresults";

  // Netlify functions (Deal early)
  const API = "https://api.netcoreleads.com/.netlify/functions";
  const HUBSPOT_SYNC_URL = API + "/hubspot-sync";

  // Storage keys for IDs
  const LEAD_ID_KEY = "hsc_lead_id";
  const DEAL_ID_KEY = "hsc_deal_id";
  const LINE_ITEM_ID_KEY = "hsc_line_item_id";

  const catalog = {
    tiers:[
      {id:"basic",name:"Basic Alarm System",price:499},
      {id:"standard",name:"Smart Home Security",price:899},
      {id:"premium",name:"Advanced AI Security",price:1499}
    ],
    install:[
      {id:"standard",name:"Standard Install",cost:299},
      {id:"advanced",name:"Advanced Install",cost:499}
    ],
    monitoring:[
      {id:"self",name:"Self Monitoring",monthly:0},
      {id:"pro",name:"24/7 Monitoring",monthly:39},
      {id:"video",name:"Pro + Video",monthly:49}
    ],
    devicePrices:{ indoorCam:129, outdoorCam:199, doorbell:179, lock:249 }
  };

  const el = (id) => document.getElementById(id);

  function getStoredAny(key){
    try{ const a = (sessionStorage.getItem(key)||"").trim(); if(a) return a; }catch(e){}
    try{ const b = (localStorage.getItem(key)||"").trim(); if(b) return b; }catch(e){}
    return "";
  }
  function setStored(key, val){
    try{ sessionStorage.setItem(key, String(val||"")); }catch(e){}
    try{ localStorage.setItem(key, String(val||"")); }catch(e){}
  }

  function readPayload(){
    try{
      const s = sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(LS_BACKUP_KEY) || "{}";
      return JSON.parse(s);
    }catch{ return {}; }
  }
  function writePayload(p){
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch(e){}
    try { localStorage.setItem(LS_BACKUP_KEY, JSON.stringify(p)); } catch(e){}
  }

  function fillSelect(id,list,label){
    const s = el(id);
    s.innerHTML="";
    list.forEach(o=>{
      const opt=document.createElement("option");
      opt.value=o.id;
      opt.textContent=label(o);
      s.appendChild(opt);
    });
  }

  fillSelect("tier",catalog.tiers,o=>`${o.name} ($${o.price})`);
  fillSelect("install",catalog.install,o=>`${o.name} ($${o.cost})`);
  fillSelect("monitoring",catalog.monitoring,o=>`${o.name} ($${o.monthly}/mo)`);

  function ensureLeadId(payload){
    let leadId = String(payload.lead_id || "").trim() || getStoredAny(LEAD_ID_KEY);
    if(!leadId){
      leadId =
        (window.crypto && typeof window.crypto.randomUUID === "function")
          ? window.crypto.randomUUID()
          : (Date.now() + "-" + Math.random().toString(16).slice(2));
    }
    payload.lead_id = leadId;
    setStored(LEAD_ID_KEY, leadId);
    return leadId;
  }

  function buildResultsUrl(payload){
    const u = new URL(RESULTS_URL);
    u.searchParams.set("lead_id", String(payload.lead_id || "").trim());
    if(payload.email) u.searchParams.set("email", String(payload.email || "").trim());
    const dealId = getStoredAny(DEAL_ID_KEY);
    if(dealId) u.searchParams.set("deal_id", dealId);
    return u.toString();
  }

  async function readText(r){ try { return await r.text(); } catch { return ""; } }
  async function fetchWithTimeout(url, options={}, ms=20000){
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { ...options, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
  }
  async function fetchJson(url, options){
    const r = await fetchWithTimeout(url, options, 20000);
    const t = await readText(r);
    let j=null; try{ j = t ? JSON.parse(t) : null; }catch(e){ j=null; }
    return { ok:r.ok, status:r.status, json:j, text:t };
  }

  async function createDealEarly(payload){
    // IMPORTANT: force defaults so the deal name isn’t blank
    payload.time_line = payload.time_line || "Researching";
    payload.home_ownership = payload.home_ownership || "Unknown";

    // Use same lead_id across pages
    ensureLeadId(payload);
    writePayload(payload);

    const res = await fetchJson(HUBSPOT_SYNC_URL, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        payload,
        // IMPORTANT: this requires the updated hubspot-sync.js I provide below
        options: { skip_contact: true }
      })
    });

    if(!res.ok || !res.json?.deal_id){
      return { ok:false, error: res.text || ("hubspot-sync failed ("+res.status+")") };
    }

    // Trust the response lead_id (hubspot-sync may normalize/override)
    if(res.json?.lead_id){
      payload.lead_id = String(res.json.lead_id).trim();
      setStored(LEAD_ID_KEY, payload.lead_id);
    }

    const dealId = String(res.json.deal_id || "").trim();
    const lineItemId = String(res.json.line_item_id || "").trim();

    setStored(DEAL_ID_KEY, dealId);
    if(lineItemId) setStored(LINE_ITEM_ID_KEY, lineItemId);

    // also persist into payload so Results can read it without query
    payload.deal_id = dealId;
    payload.line_item_id = lineItemId;
    writePayload(payload);

    return { ok:true, deal_id: dealId, line_item_id: lineItemId };
  }

  function calculate(){
    const tier = catalog.tiers.find(x => x.id === el("tier").value);
    const inst = catalog.install.find(x => x.id === el("install").value);
    const mon  = catalog.monitoring.find(x => x.id === el("monitoring").value);

    const indoor = parseInt(el("indoorCam").value)||0;
    const outdoor = parseInt(el("outdoorCam").value)||0;
    const door = parseInt(el("doorbell").value)||0;
    const lock = parseInt(el("lock").value)||0;

    const upfront = tier.price + inst.cost +
      indoor*catalog.devicePrices.indoorCam +
      outdoor*catalog.devicePrices.outdoorCam +
      door*catalog.devicePrices.doorbell +
      lock*catalog.devicePrices.lock;

    const monthly = mon.monthly;

    el("upfront").textContent = "$" + upfront.toLocaleString();
    el("monthly").textContent = "$" + monthly.toLocaleString() + "/mo";

    const summary=[];
    if(indoor) summary.push(`Indoor x${indoor}`);
    if(outdoor) summary.push(`Outdoor x${outdoor}`);
    if(door) summary.push(`Doorbell x${door}`);
    if(lock) summary.push(`Locks x${lock}`);

    el("device-summary").textContent = summary.length ? summary.join(", ") : "No devices selected";

    const payload = readPayload();
    payload.tier=tier.id;
    payload.install=inst.id;
    payload.monitoring=mon.id;

    payload.indoorCam=indoor;
    payload.outdoorCam=outdoor;
    payload.doorbell=door;
    payload.lock=lock;

    payload.upfront=upfront;
    payload.monthly=monthly;

    payload.hsc_upfront=upfront;
    payload.hsc_monthly=monthly;
    payload.hsc_devices=summary.join(", ");

    // keep lead_id stable
    ensureLeadId(payload);

    // keep any existing email/address from step 1
    payload.email = payload.email || getStoredAny("hsc_email") || "";

    writePayload(payload);
    return payload;
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const payload = readPayload();

    if(!payload.email){
      window.location.href = "https://www.homesecurecalculator.com/";
      return;
    }

    el("addrLine").textContent = payload.address || payload.geo?.formatted || payload.hsc_property_address || "—";

    document.querySelectorAll("select,input").forEach(n=>{
      n.addEventListener("input", calculate);
      n.addEventListener("change", calculate);
    });

    el("submit-btn").addEventListener("click", async () => {
      const btn = el("submit-btn");
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Creating your listing…";

      try{
        const p = calculate();

        const created = await createDealEarly(p);
        if(!created.ok){
          alert("Could not create your listing (deal).\n\n" + created.error);
          btn.disabled = false;
          btn.textContent = original;
          return;
        }

        btn.textContent = "Redirecting…";
        window.location.href = buildResultsUrl(p);

      } catch(e){
        alert("Error:\n" + String(e?.message || e));
        btn.disabled = false;
        btn.textContent = original;
      }
    });

    calculate();
  });
})();
</script>

</body>
</html>
