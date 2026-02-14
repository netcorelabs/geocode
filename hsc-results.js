document.addEventListener("DOMContentLoaded", function() {
    const root = document.getElementById("results-root");
    if(!root) return;

    // Retrieve calculator inputs from localStorage
    const homeValue = localStorage.getItem("calc_home_value") || "N/A";
    const securityLevel = localStorage.getItem("calc_security_level") || "N/A";

    // Retrieve UTM info for analytics if needed
    const utms = ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].reduce((acc, key) => {
        acc[key] = localStorage.getItem(key) || "N/A";
        return acc;
    }, {});

    // Render results (replace with your actual map/chart logic)
    root.innerHTML = `
        <p>🏠 Home Value: $${homeValue}</p>
        <p>🔒 Security Level: ${securityLevel}</p>
        <div id="crime-map" style="height:400px; border:1px solid #ccc;">
            Map loading here...
        </div>
        <div id="utm-data" style="margin-top:20px; font-size:12px; color:#666;">
            <p>UTM Data for tracking:</p>
            <pre>${JSON.stringify(utms,null,2)}</pre>
        </div>
    `;

    // Example: Call your existing Netlify JS function for crime map
    if(window.loadCrimeMap) {
        window.loadCrimeMap("crime-map"); // Replace with your real map function
    }
});
