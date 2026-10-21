/**
 * LabRoute — Admin authentication and the pending upload review queue.
 *
 * The server issues a signed, HttpOnly admin cookie on successful login. The
 * original browser-only check is kept as a fallback for purely static
 * deployments, where the /api endpoints do not exist.
 */

// 1. Password visibility toggle
const togglePasswordBtn = document.getElementById('togglePassword');
const passwordInput = document.getElementById('password');
const toggleIcon = document.getElementById('toggleIcon');

if (togglePasswordBtn && passwordInput && toggleIcon) {
  togglePasswordBtn.addEventListener('click', () => {
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    toggleIcon.textContent = isPassword ? 'visibility_off' : 'visibility';
  });
}

// 2. Hash encoder (Web Crypto API SHA-256)
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// 3. Login
const loginForm = document.getElementById('loginForm');
const loginBtn = document.getElementById('loginBtn');
const message = document.getElementById('message');

if (loginForm) {
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    if (loginBtn) {
      loginBtn.disabled = true;
      loginBtn.textContent = 'Verifying...';
    }
    hideMessage();

    const serverResult = await loginWithServer(email, password);

    if (serverResult.unavailable) {
      const fallback = await loginWithBrowserData(email, password);

      if (fallback.ok) {
        completeLogin(fallback.email);
      } else {
        showMessage(fallback.message, 'error');
        resetLoginBtn();
      }
      return;
    }

    if (serverResult.ok) {
      completeLogin(serverResult.email);
    } else {
      showMessage(serverResult.message, 'error');
      resetLoginBtn();
    }
  });
}

async function loginWithServer(email, password) {
  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password })
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return { unavailable: true };
    }

    const data = await response.json().catch(() => ({}));

    if (response.ok && data.ok) {
      return { ok: true, email: data.email || email };
    }

    if (response.status === 404 || response.status === 405 || response.status === 501) {
      return { unavailable: true };
    }

    return {
      ok: false,
      message: data.message || 'Incorrect institutional email or security key.'
    };
  } catch {
    return { unavailable: true };
  }
}

async function loginWithBrowserData(email, password) {
  try {
    const response = await fetch('../data/admins.json');

    if (!response.ok) {
      throw new Error('Could not load the admin database.');
    }

    const data = await response.json();
    const enteredPasswordHash = await hashPassword(password);

    const admin = data.admins.find(
      (candidate) =>
        candidate.email === email && candidate.passwordCrypt === enteredPasswordHash
    );

    if (!admin) {
      return {
        ok: false,
        message: 'Incorrect institutional email or security key.'
      };
    }

    return { ok: true, email: admin.email };
  } catch (error) {
    console.error(error);
    return {
      ok: false,
      message: 'Unable to authenticate. Check the server data path.'
    };
  }
}

function completeLogin(email) {
  sessionStorage.setItem('isAdmin', 'true');
  sessionStorage.setItem('adminEmail', email);
  showMessage('Authentication verified. Redirecting...', 'success');

  window.setTimeout(() => {
    window.location.href = 'dashboard.html';
  }, 700);
}

function resetLoginBtn() {
  if (loginBtn) {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Authenticate';
  }
}

function showMessage(text, type) {
  if (!message) return;
  message.textContent = text;
  message.className = `auth-alert ${type}`;
}

function hideMessage() {
  if (!message) return;
  message.className = 'auth-alert hidden';
}

// 4. Protect the dashboard and verify the server session
const dashboard = document.getElementById('dashboard');

if (dashboard) {
  guardDashboard();
}

async function guardDashboard() {
  const localSession = sessionStorage.getItem('isAdmin') === 'true';
  const server = await getServerSession();

  if (server.available && server.authenticated) {
    sessionStorage.setItem('isAdmin', 'true');
    if (server.email) sessionStorage.setItem('adminEmail', server.email);
    updateAdminEmailDisplay();
    loadPendingUploads();
    return;
  }

  if (server.available && server.authenticated === false) {
    sessionStorage.removeItem('isAdmin');
    sessionStorage.removeItem('adminEmail');
    window.location.href = 'login.html';
    return;
  }

  // Static deployment: the API is unavailable, so keep the browser check.
  if (!localSession) {
    window.location.href = 'login.html';
    return;
  }

  updateAdminEmailDisplay();
  loadPendingUploads();
}

async function getServerSession() {
  try {
    const response = await fetch('/api/admin/session', {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('application/json')) {
      return { available: false };
    }

    const data = await response.json();
    return {
      available: true,
      authenticated: Boolean(data.authenticated),
      email: data.email || null
    };
  } catch {
    return { available: false };
  }
}

// 5. Display the signed-in admin's email
function updateAdminEmailDisplay() {
  const adminEmailElement = document.getElementById('adminEmail');
  if (!adminEmailElement) return;

  const adminEmail = sessionStorage.getItem('adminEmail');
  if (adminEmail) adminEmailElement.textContent = adminEmail;
}

// 6. Pending uploads awaiting an admin decision
async function loadPendingUploads() {
  const container = document.getElementById('pendingInbox');
  const countElement = document.getElementById('pendingCount');
  const statusElement = document.getElementById('pendingStatus');
  if (!container) return;

  try {
    const response = await fetch('/api/admin/pending', {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });

    if (response.status === 401) {
      sessionStorage.removeItem('isAdmin');
      sessionStorage.removeItem('adminEmail');
      window.location.href = 'login.html';
      return;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('application/json')) {
      throw new Error('The review service is not available.');
    }

    const data = await response.json();
    renderStorageWarning(data.storage);
    renderPendingUploads(container, countElement, data.pending || [], data.liveCount || 0);
  } catch (error) {
    if (countElement) countElement.textContent = '—';
    if (statusElement) statusElement.textContent = '';
    container.innerHTML = `
      <div class="moments-inbox-state is-error">
        <span class="material-symbols-outlined">cloud_off</span>
        <p>Pending uploads need the LabRoute service. Start it with <code>npm start</code>.</p>
      </div>`;
  }
}

/**
 * Say plainly when approvals are not permanent.
 *
 * The API reports `storage.durable: false` when approved photos are only in a
 * serverless instance's /tmp. In that state the photo shows in the gallery
 * until the instance recycles — the exact "approved image disappeared after a
 * refresh" symptom — so the admin must see it before approving anything.
 */
function renderStorageWarning(storage) {
  const element = document.getElementById('storageWarning');
  if (!element) return;

  if (!storage || storage.durable !== false) {
    element.hidden = true;
    element.innerHTML = '';
    return;
  }

  const details = [storage.message, storage.hint].filter(Boolean).join(' ');

  element.innerHTML = `
    <span class="material-symbols-outlined" aria-hidden="true">warning</span>
    <div>
      <strong>Approvals are temporary</strong>
      <p>${escapeHtml(details)}</p>
    </div>`;
  element.hidden = false;
}

function renderPendingUploads(container, countElement, pending, liveCount) {
  if (countElement) countElement.textContent = String(pending.length);

  if (!pending.length) {
    container.innerHTML = `
      <div class="moments-inbox-state">
        <span class="material-symbols-outlined">task_alt</span>
        <p>Nothing to review. ${liveCount} photo${liveCount === 1 ? ' is' : 's are'} live in the gallery.</p>
      </div>`;
    return;
  }

  container.innerHTML = pending
    .map((moment) => {
      const id = escapeHtml(moment.id);
      const caption = escapeHtml(moment.caption || 'Untitled lab moment');
      const contributor = escapeHtml(moment.contributor || 'Anonymous contributor');
      const date = formatDate(moment.uploadedAt);

      return `
        <article class="moments-card pending-card" data-id="${id}">
          <img src="/api/admin/pending/${encodeURIComponent(moment.id)}/image" alt="${caption}" loading="lazy" />
          <div class="moments-card-body">
            <span class="pending-flag">Action required</span>
            <h3 class="moments-caption">${caption}</h3>
            <p class="moments-meta">${contributor}${date ? ` · ${date}` : ''}</p>
            <div class="pending-downloads">
              <a class="btn btn-outline btn-sm" href="/api/admin/pending/${encodeURIComponent(moment.id)}/download" download>
                <span class="material-symbols-outlined">download</span>
                <span>Download photo</span>
              </a>
              <a class="btn btn-outline btn-sm" href="/api/admin/pending/${encodeURIComponent(moment.id)}/metadata" download>
                <span class="material-symbols-outlined">data_object</span>
                <span>Download JSON</span>
              </a>
            </div>
            <div class="pending-actions">
              <button type="button" class="btn btn-primary btn-sm" data-action="approve" data-id="${id}">
                <span class="material-symbols-outlined">check</span>
                <span>Approve</span>
              </button>
              <button type="button" class="btn btn-outline btn-sm" data-action="publish" data-id="${id}">
                <span class="material-symbols-outlined">upload_file</span>
                <span>Already committed</span>
              </button>
              <button type="button" class="btn btn-outline btn-sm" data-action="reject" data-id="${id}">
                <span class="material-symbols-outlined">close</span>
                <span>Decline</span>
              </button>
            </div>
          </div>
        </article>`;
    })
    .join('');
}

async function reviewPending(id, action, button) {
  const statusElement = document.getElementById('pendingStatus');
  const card = button.closest('.pending-card');

  if (!id || !action) return;

  button.disabled = true;
  const buttons = card ? card.querySelectorAll('button') : [];
  buttons.forEach((item) => {
    item.disabled = true;
  });

  if (statusElement) {
    statusElement.textContent =
      action === 'approve'
        ? 'Approving photo…'
        : action === 'publish'
          ? 'Removing from the review queue…'
          : 'Declining photo…';
  }

  try {
    const response = await fetch(`/api/admin/pending/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: { Accept: 'application/json' }
    });

    if (response.status === 401) {
      window.location.href = 'login.html';
      return;
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.message || 'That review action could not be completed.');
    }

    if (statusElement) {
      // The server message carries the temporary-storage caveat when it
      // applies, so prefer it over a hard-coded success line.
      statusElement.textContent =
        data.message ||
        (action === 'approve'
          ? 'Approved. The photo is now image 1 in the gallery.'
          : action === 'publish'
            ? 'Marked as published.'
            : 'Declined. The photo was removed.');
    }

    await loadPendingUploads();
  } catch (error) {
    if (statusElement) statusElement.textContent = error.message;

    buttons.forEach((item) => {
      item.disabled = false;
    });
  }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action][data-id]');
  if (!button) return;

  event.preventDefault();
  reviewPending(button.dataset.id, button.dataset.action, button);
});

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}

// 7. Logout
const logoutButton = document.getElementById('logoutButton');

if (logoutButton) {
  logoutButton.addEventListener('click', () => {
    fetch('/api/admin/logout', {
      method: 'POST',
      headers: { Accept: 'application/json' }
    }).catch(() => {});

    sessionStorage.removeItem('isAdmin');
    sessionStorage.removeItem('adminEmail');
    window.location.href = 'login.html';
  });
}
