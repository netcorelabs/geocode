<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Smart Home Security Lead Form</title>

<style>
/* ==============================
   Lead Form Styles
============================== */
.hsc-lead-module {
  max-width: 640px;
  margin: 60px auto;
  padding: 50px;
  border-radius: 20px;
  background: linear-gradient(135deg, #f8fafc, #e0f2fe);
  box-shadow: 0 20px 60px rgba(0,0,0,.08);
  font-family: "Segoe UI", sans-serif;
}

.hsc-lead-module h2 {
  font-size: 32px;
  margin-bottom: 20px;
  color: #1e3a8a;
  text-align: center;
}

.lead-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.form-row {
  position: relative;
  display: flex;
  flex-direction: column;
}

.form-row input {
  width: 100%;
  padding: 18px 14px 14px;
  border-radius: 12px;
  border: 1px solid #cbd5e1;
  font-size: 16px;
  background: white;
  transition: border-color 0.3s;
}

.form-row input:focus {
  border-color: #0ea5e9;
  outline: none;
  box-shadow: 0 0 0 3px rgba(14,165,233,.2);
}

.form-row label {
  position: absolute;
  top: 16px;
  left: 14px;
  font-size: 16px;
  color: #64748b;
  pointer-events: none;
  transition: 0.2s ease all;
  background: white;
  padding: 0 4px;
}

.form-row input:focus + label,
.form-row input:not(:placeholder-shown) + label {
  top: -10px;
  font-size: 12px;
  color: #0ea5e9;
}

.form-row.full-width button {
  padding: 18px;
  border-radius: 14px;
  border: none;
  font-size: 18px;
  font-weight: 600;
  color: white;
  cursor: pointer;
  background: linear-gradient(135deg,#1e3a8a,#0ea5e9);
  transition: transform 0.2s, box-shadow 0.2s;
}

.form-row.full-width button:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 20px rgba(14,165,233,.4);
}

#address-container input {
  width: 100%;
  padding: 18px 14px 14px;
  border-radius: 12px;
  border: 1px solid #cbd5e1;
  font-size: 16px;
}

#address-container input:focus {
  border-color: #0ea5e9;
  box-shadow: 0 0 0 3px rgba(14,165,233,.2);
}

@media(max-width:768px){
  .hsc-lead-module{padding:30px 20px;}
  .hsc-lead-module h2{font-size:28px;}
  .form-row input,.form-row.full-width button{font-size:16px;}
}
</style>
</head>

<body>

<section class="hsc-lead-module">
  <h2>Get Your Free Smart Home Security Estimate</h2>
  <form id="hsc-lead-form" class="lead-form">
    <div class="form-row">
      <input type="text" id="firstname" placeholder=" " required>
      <label for="firstname">First Name</label>
    </div>

    <div class="form-row">
      <input type="text" id="lastname" placeholder=" " required>
      <label for="lastname">Last Name</label>
    </div>

    <div class="form-row">
      <input type="email" id="email" placeholder=" " required>
      <label for="email">Email</label>
    </div>

    <div class="form-row">
      <input type="tel" id="phone" placeholder=" " required>
      <label for="phone">Phone</label>
    </div>

    <div class="form-row">
      <div id="address-container"></div>
    </div>

    <div class="form-row full-width">
      <button type="submit">Compare My Options</button>
    </div>
  </form>
</section>

<script>
(function() {

const UTM_KEYS = ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"];
const NETLIFY_FUNCTION = "https://hubspotgate.netlify.app/.netlify/functions/submit-lead";
const REDIRECT_URL = "https://www.homesecurecalculator.com/hscalcregion";

// store UTM params
const urlParams = new URLSearchParams(window.location.search);
UTM_KEYS.forEach(key=>{
  const val = urlParams.get(key);
  if(val) localStorage.setItem(key,val);
});

document.addEventListener("DOMContentLoaded",function(){

  const form = document.getElementById("hsc-lead-form");
  const addressContainer = document.getElementById("address-container");

  // -------------------------
  // Load Google Maps PlaceAutocompleteElement
  // -------------------------
  function loadGoogleMaps(){
    if(window.google?.maps?.places?.PlaceAutocompleteElement){
      initAutocomplete();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://maps.googleapis.com/maps/api/js?key=AIzaSyC7EeMaBJWTgZ8ZdtyjjJFfzTv_ZpuhmLA&libraries=places";
    script.async = true;
    script.defer = true;
    script.onload = ()=> {
      if(window.google?.maps?.places?.PlaceAutocompleteElement) initAutocomplete();
      else console.error("Google Maps Places library failed to load.");
    };
    document.head.appendChild(script);
  }

  window.initAutocomplete = function(){
    const placeInput = new google.maps.places.PlaceAutocompleteElement();
    placeInput.id = "address";
    placeInput.placeholder = "Street Address";
    placeInput.required = true;
    placeInput.style.width = "100%";
    addressContainer.appendChild(placeInput);

    placeInput.addEventListener("gmp-select", async ({placePrediction})=>{
      const place = placePrediction.toPlace();
      await place.fetchFields({fields:["formattedAddress"]});
      if(place.formattedAddress) localStorage.setItem("lead_address",place.formattedAddress);
    });
  };

  loadGoogleMaps();

  // -------------------------
  // Submit Form
  // -------------------------
  form.addEventListener("submit",async function(e){
    e.preventDefault();

    const addressInput = document.querySelector("#address");
    const data = {
      firstname: document.getElementById("firstname").value.trim(),
      lastname: document.getElementById("lastname").value.trim(),
      email: document.getElementById("email").value.trim(),
      phone: document.getElementById("phone").value.trim(),
      address: addressInput?.value || localStorage.getItem("lead_address") || "",
      pageUri: window.location.href
    };

    UTM_KEYS.forEach(k=> data[k]=localStorage.getItem(k)||"");

    if(!data.firstname||!data.lastname||!data.email||!data.phone||!data.address){
      alert("Please complete all fields.");
      return;
    }

    try{
      const res = await fetch(NETLIFY_FUNCTION,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(data)
      });

      if(!res.ok){
        const text = await res.text();
        throw new Error(text);
      }

      localStorage.setItem("lead_email",data.email);
      localStorage.setItem("lead_address",data.address);

      window.location.href = REDIRECT_URL + "?address=" + encodeURIComponent(data.address) + "&email=" + encodeURIComponent(data.email);

    }catch(err){
      console.error("Submission error:",err);
      alert("Submission failed. Please try again.");
    }
  });

});
})();
</script>
</body>
</html>
