/**
 * MyEla - Admin Controller & Authentication
 */

// 1. Password Visibility Toggle (New UI Hook)
const togglePasswordBtn = document.getElementById("togglePassword");
const passwordInput = document.getElementById("password");
const toggleIcon = document.getElementById("toggleIcon");

if (togglePasswordBtn && passwordInput && toggleIcon) {
  togglePasswordBtn.addEventListener("click", () => {
    const isPassword = passwordInput.type === "password";
    passwordInput.type = isPassword ? "text" : "password";
    toggleIcon.textContent = isPassword ? "visibility_off" : "visibility";
  });
}

// 2. Hash Encoder (Web Crypto API SHA-256)
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// 3. Login Submission
const loginForm = document.getElementById("loginForm");
const loginBtn = document.getElementById("loginBtn");
const message = document.getElementById("message");

if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    // UI Loading state
    if (loginBtn) {
      loginBtn.disabled = true;
      loginBtn.textContent = "Verifying...";
    }
    hideMessage();

    try {
      // Check your admins JSON path
      const response = await fetch("../data/admins.json");

      if (!response.ok) {
        throw new Error("Could not load admin database.");
      }

      const data = await response.json();
      const enteredPasswordHash = await hashPassword(password);

      // Match admin credentials
      const admin = data.admins.find(
        (a) => a.email === email && a.passwordCrypt === enteredPasswordHash
      );

      if (admin) {
        sessionStorage.setItem("isAdmin", "true");
        sessionStorage.setItem("adminEmail", admin.email);

        showMessage("Authentication verified. Redirecting...", "success");

        setTimeout(() => {
          window.location.href = "dashboard.html";
        }, 900);
      } else {
        showMessage("Incorrect institutional email or security key.", "error");
        resetLoginBtn();
      }
    } catch (error) {
      console.error(error);
      showMessage("Unable to authenticate. Check server data path.", "error");
      resetLoginBtn();
    }
  });
}

// Helper to reset button
function resetLoginBtn() {
  if (loginBtn) {
    loginBtn.disabled = false;
    loginBtn.textContent = "Authenticate";
  }
}

// UI Alert Helpers
function showMessage(text, type) {
  if (!message) return;
  message.textContent = text;
  message.className = `auth-alert ${type}`;
}

function hideMessage() {
  if (!message) return;
  message.className = "auth-alert hidden";
}

// 4. Protect Dashboard Route
const dashboard = document.getElementById("dashboard");
if (dashboard) {
  if (sessionStorage.getItem("isAdmin") !== "true") {
    window.location.href = "login.html";
  }
}

// 5. Display admin's email on dashboard
const adminEmailElement = document.getElementById("adminEmail");
if (adminEmailElement) {
  const adminEmail = sessionStorage.getItem("adminEmail");
  if (adminEmail) {
    adminEmailElement.textContent = adminEmail;
  }
}

// 6. Logout Handler
const logoutButton = document.getElementById("logoutButton");
if (logoutButton) {
  logoutButton.addEventListener("click", () => {
    sessionStorage.removeItem("isAdmin");
    sessionStorage.removeItem("adminEmail");
    window.location.href = "login.html";
  });
}