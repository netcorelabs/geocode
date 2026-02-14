// Store any UTMs in localStorage
function storeUTMs() {
    const params = new URLSearchParams(window.location.search);
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach(key => {
        const value = params.get(key);
        if(value) localStorage.setItem(key, value);
    });
}
storeUTMs();

document.addEventListener("DOMContentLoaded", function() {
    const root = document.getElementById("calculator-root");
    if(!root) return;

    // Render calculator (replace with your actual logic if needed)
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

    // On calculator submit
    const submitBtn = document.getElementById("calc-submit-btn");
    submitBtn.addEventListener("click", function() {
        const homeValue = document.getElementById("home-value").value;
        const level = document.getElementById("security-level").value;

        // Save inputs to localStorage
        localStorage.setItem("calc_home_value", homeValue);
        localStorage.setItem("calc_security_level", level);

        // Redirect to Results page
        window.location.href = "https://hubspotgate.netlify.app/results.html";
    });
});
