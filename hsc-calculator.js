// 1️⃣ Store UTMs from landing page
function storeUTMs() {
    const params = new URLSearchParams(window.location.search);
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach(key => {
        const value = params.get(key);
        if(value) localStorage.setItem(key, value);
    });
}
storeUTMs();

// 2️⃣ Render calculator after DOM loads
document.addEventListener("DOMContentLoaded", function() {
    const root = document.getElementById("calculator-root");
    if(!root) return;

    // Replace below with your actual calculator logic
    root.innerHTML = `
        <div class="calculator-container">
            <label>Home Value ($): <input type="number" id="home-value" /></label><br/>
            <label>Security Level:
                <select id="security-level">
                    <option value="basic">Basic</option>
                    <option value="standard">Standard</option>
                    <option value="premium">Premium</option>
                </select>
            </label><br/>
            <button id="calc-submit-btn">Calculate</button>
        </div>
    `;

    const submitBtn = document.getElementById("calc-submit-btn");
    submitBtn.addEventListener("click", function() {
        const homeValue = document.getElementById("home-value").value;
        const level = document.getElementById("security-level").value;

        // Save data to localStorage to pass to results page
        localStorage.setItem("calc_home_value", homeValue);
        localStorage.setItem("calc_security_level", level);

        // Redirect to results page
        window.location.href = "https://hubspotgate.netlify.app/results.html";
    });
});
