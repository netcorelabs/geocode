
// /public/js/calculatorNetlify.js
(function(){
  const ENDPOINTS_BASE = "https://api.netcoreleads.com/.netlify/functions";
  const ENDPOINTS = {
    hubspotSync: ENDPOINTS_BASE + "/hubspot-sync",
    uploadDeliverables: ENDPOINTS_BASE + "/upload-deliverables",
    visitorPdfLink: ENDPOINTS_BASE + "/visitor-pdf-link"
  };

  function collectFormData() {
    const form = document.getElementById("calculatorForm");
    if (!form) return null;
    const data = {};
    Array.from(form.elements).forEach(el => {
      if(el.name) data[el.name] = el.value;
    });
    return data;
  }

  function blobToBase64(blob){
    return new Promise((resolve,reject)=>{
      const r = new FileReader();
      r.onload = ()=>resolve((r.result.split(",")[1]||"").trim());
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  function buildUnredactedLeadCsv(payload){
    const headers = ["lead_id","firstname","lastname","email","phone","street_address","city","state","zip","country","hsc_property_address","home_ownership","time_line"];
    const row = [
      payload.lead_id||"",
      payload.firstname||"",
      payload.lastname||"",
      payload.email||"",
      payload.phone||"",
      payload.street_address||"",
      payload.city||"",
      payload.state_code||payload.state||"",
      payload.postal_code||payload.zip||"",
      payload.country_region||"",
      payload.hsc_property_address||"",
      payload.home_ownership||"",
      payload.time_line||""
    ];
    const esc = v=>/[,"\n]/.test(v)?`"${v.replace(/"/g,'""')}"`:v;
    return headers.map(esc).join(",") + "\n" + row.map(esc).join(",") + "\n";
  }

  async function buildPdfBlob(payload){
    const jsPDFCtor = window.jspdf.jsPDF;
    const doc = new jsPDFCtor({ unit:"pt", format:"letter" });
    let y = 50, margin = 48, pageW = doc.internal.pageSize.getWidth();

    doc.setFont("helvetica","bold"); doc.setFontSize(16);
    doc.text("Home Secure Calculator — Security Report", pageW/2, y, { align:"center" });
    y+=30;

    doc.setFont("helvetica","normal"); doc.setFontSize(12);
    Object.entries(payload).forEach(([k,v])=>{
      doc.text(`${k}: ${v}`, margin, y);
      y+=16;
    });

    return doc.output("blob");
  }

  async function submitCalculator() {
    let payload = collectFormData();
    if (!payload) return alert("Form data missing.");
    sessionStorage.setItem("hsc_payload", JSON.stringify(payload));

    // 1️⃣ Ensure deal exists
    let deal_id;
    try {
      const res = await fetch(ENDPOINTS.hubspotSync, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ payload })
      });
      const data = await res.json();
      deal_id = data.lead_id || data.deal_id || String(Date.now());
      payload.lead_id = deal_id;
      sessionStorage.setItem("hsc_payload", JSON.stringify(payload));
    } catch(e) {
      console.error("Hubspot Sync failed:",e);
      return alert("Lead creation failed. Try again.");
    }

    // 2️⃣ Build PDF + CSV
    let pdfBlob;
    try { pdfBlob = await buildPdfBlob(payload); } catch(e){ return alert("PDF build failed."); }
    const pdfB64 = await blobToBase64(pdfBlob);
    const csvText = buildUnredactedLeadCsv(payload);

    // 3️⃣ Upload deliverables
    try {
      await fetch(ENDPOINTS.uploadDeliverables, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          deal_id,
          pdf_base64: pdfB64,
          csv_text: csvText,
          pdf_filename:`lead-${deal_id}.pdf`,
          csv_filename:`lead-${deal_id}.csv`
        })
      });
    } catch(e) {
      console.error("Upload failed:",e);
      return alert("Upload failed. Try again.");
    }

    // 4️⃣ Redirect to Thank You page
    window.location.href = "/thankyou.html";
  }

  // Bind button
  const btn = document.getElementById("calculatorSubmitBtn");
  if(btn) btn.addEventListener("click", submitCalculator);

})();
