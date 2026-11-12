/**
 * LabRoute — Admin authentication and the pending upload review queue.
 *
 * The server issues a signed, HttpOnly admin cookie on successful login. The
 * database is server-only. Browser storage is display state, never authentication.
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
      return { ok: false, message: 'The authentication service is unavailable. Please try again shortly.' };
    }

    const data = await response.json().catch(() => ({}));

    if (response.ok && data.ok) {
      return { ok: true, email: data.email || email };
    }

    if (response.status === 404 || response.status === 405 || response.status === 501) {
      return { ok: false, message: 'The authentication service is unavailable. Please try again shortly.' };
    }

    return {
      ok: false,
      message: data.message || 'Incorrect institutional email or security key.'
    };
  } catch {
    return { ok: false, message: 'The authentication service is unavailable. Please try again shortly.' };
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

  const status = document.getElementById('pendingStatus');
  if (status) status.textContent = 'The review service is unavailable. Refresh to reconnect; saved uploads remain in the database.';
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
        <p>The review service is temporarily unavailable. Refresh to reconnect. Previously saved uploads have not been removed.</p>
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
      <strong>Durable storage is not configured</strong>
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
            <span class="pending-flag">Awaiting approval</span>
            <h3 class="moments-caption">${caption}</h3>
            <p class="moments-meta">${contributor}${date ? ` · ${date}` : ''}</p>

            <p class="pending-help">Saved for review. Approve to publish this photo first in the gallery, or reject to remove it.</p>

            <div class="pending-actions">
              <button type="button" class="btn btn-primary btn-sm" data-action="approve" data-id="${id}">
                <span class="material-symbols-outlined">check</span>
                <span>Approve</span>
              </button>
              <button type="button" class="btn btn-outline btn-sm" data-action="reject" data-id="${id}">
                <span class="material-symbols-outlined">close</span>
                <span>Reject</span>
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
      action === 'approve' ? 'Publishing photo to the gallery…' : 'Rejecting photo…';
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

    if (statusElement) statusElement.classList.remove('is-warning');

    if (statusElement) {
      // Prefer the server's confirmed publication result over a local guess.
      statusElement.textContent =
        data.message ||
        (action === 'approve'
          ? 'Approved. The photo is now image 1 in the gallery.'
          : 'Declined. The photo was removed.');
    }

    if (action === 'approve') {
      try { localStorage.setItem('labroute-gallery-updated', String(Date.now())); } catch {}
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

const refreshPendingButton = document.getElementById('refreshPending');
if (refreshPendingButton) refreshPendingButton.addEventListener('click', loadPendingUploads);

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
