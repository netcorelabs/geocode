document.addEventListener("DOMContentLoaded", function() {
    const root = document.getElementById("results-root");
    if(!root) return;

    const homeValue = localStorage.getItem("calc_home_value") || "N/A";
    const securityLevel = localStorage.getItem("calc_security_level") || "N/A";

    const utms = ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].reduce((acc, key) => {
        acc[key] = localStorage.getItem(key) || "N/A";
        return acc;
    }, {});

    root.innerHTML = `
        <p>🏠 Home Value: $${homeValue}</p>
        <p>🔒 Security Level: ${securityLevel}</p>
        <div id="crime-map" style="height:400px; border:1px solid #ccc; margin-top: 20px;">
            Map will load here...
        </div>
        <div id="utm-data" style="margin-top:20px; font-size:12px; color:#666;">
            <p>UTM Data:</p>
            <pre>${JSON.stringify(utms,null,2)}</pre>
        </div>
    `;

    // Example: load crime map if you have a global function
    if(window.loadCrimeMap) {
        window.loadCrimeMap("crime-map");
    }
});
