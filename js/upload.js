/**
 * LabRoute — share a lab moment.
 *
 * The photo is previewed locally, then sent to the review queue. Nothing is
 * published until an administrator approves it from the dashboard.
 */
(function () {
  'use strict';

  const DEVICE_STORAGE_KEY = 'labroute_device_id';
  const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const ALLOWED_EXTENSIONS = /\.(jpe?g|png|webp)$/i;

  const state = {
    file: null,
    previewUrl: '',
    deviceId: '',
    maxBytes: 8 * 1024 * 1024,
    cooldownMinutes: 30,
    cooldownUntil: 0,
    cooldownReason: 'visitor',
    cooldownTimer: null,
    busy: false,
    apiAvailable: true,
    statusRetryTimer: null,
    statusAlertShown: false
  };

  const el = {};

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    const required = [
      'dropzone',
      'photoInput',
      'photoPreview',
      'previewImage',
      'previewName',
      'previewMeta',
      'removePhoto',
      'cooldownBanner',
      'cooldownTitle',
      'cooldownText',
      'momentForm',
      'caption',
      'captionCount',
      'contributor',
      'consent',
      'website',
      'formAlert',
      'submitBtn',
      'submitLabel',
      'uploadPanel',
      'successPanel',
      'successMessage',
      'shareAnotherBtn',
      'successCooldown'
    ];

    for (const id of required) el[id] = document.getElementById(id);
    el.dropzoneHint = document.getElementById('dropzoneHint');

    if (!el.momentForm || !el.dropzone || !el.photoInput) return;

    state.deviceId = getDeviceId();

    el.formAlert.setAttribute('tabindex', '-1');
    el.photoInput.addEventListener('change', () => handleFiles(el.photoInput.files));
    el.dropzone.addEventListener('click', openFilePicker);
    el.dropzone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openFilePicker();
      }
    });

    bindDragAndDrop();
    el.removePhoto.addEventListener('click', clearSelection);
    el.caption.addEventListener('input', updateCaptionCount);
    el.consent.addEventListener('change', updateSubmitState);
    el.momentForm.addEventListener('submit', handleSubmit);
    el.shareAnotherBtn.addEventListener('click', startAnother);

    ['dragover', 'drop'].forEach((type) => {
      document.addEventListener(type, (event) => {
        if (!event.target.closest || !event.target.closest('#dropzone')) {
          event.preventDefault();
        }
      });
    });

    updateCaptionCount();
    updateSubmitState();
    refreshStatus();
  }

  /* ---------------------------------------------------------------- helpers */

  function getDeviceId() {
    try {
      const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY);
      if (existing && /^[A-Za-z0-9_-]{8,128}$/.test(existing)) return existing;

      let generated = '';

      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        generated = window.crypto.randomUUID();
      } else if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        generated = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      } else {
        generated = `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      }

      window.localStorage.setItem(DEVICE_STORAGE_KEY, generated);
      return generated;
    } catch (error) {
      // Private-mode browsers can refuse localStorage. The signed visitor
      // cookie still provides a cooldown; this is only a second signal.
      return '';
    }
  }

  function apiHeaders(extra) {
    return Object.assign(
      { Accept: 'application/json' },
      state.deviceId ? { 'X-Labroute-Device': state.deviceId } : {},
      extra || {}
    );
  }

  function isCoolingDown() {
    return state.cooldownUntil > Date.now();
  }

  function formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
    }

    if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    return `${seconds}s`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function fileExtension(file) {
    const match = String(file.name || '').match(ALLOWED_EXTENSIONS);
    return match ? match[0].slice(1).toLowerCase() : '';
  }

  /* ------------------------------------------------------------------ alert */

  function showAlert(message) {
    if (!el.formAlert) return;

    el.formAlert.textContent = message;
    el.formAlert.hidden = false;
    el.formAlert.focus({ preventScroll: false });
  }

  function clearAlert() {
    if (!el.formAlert) return;

    el.formAlert.textContent = '';
    el.formAlert.hidden = true;
  }

  /* ------------------------------------------------------------- file input */

  function openFilePicker() {
    // Choosing/previewing a photo is purely local, so it stays available
    // while the sharing service is being (re)contacted.
    if (state.busy || isCoolingDown()) return;
    el.photoInput.click();
  }

  function bindDragAndDrop() {
    const zone = el.dropzone;

    ['dragenter', 'dragover'].forEach((type) => {
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        if (state.busy || isCoolingDown()) return;
        zone.classList.add('is-dragover');
      });
    });

    ['dragleave', 'dragend', 'drop'].forEach((type) => {
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        zone.classList.remove('is-dragover');
      });
    });

    zone.addEventListener('drop', (event) => {
      if (state.busy || isCoolingDown()) return;
      handleFiles(event.dataTransfer ? event.dataTransfer.files : null);
    });
  }

  function handleFiles(fileList) {
    clearAlert();

    const file = fileList && fileList[0];
    if (!file) return;

    if (!ALLOWED_TYPES.has(file.type) && !fileExtension(file)) {
      showAlert('Please choose a JPEG, PNG, or WebP photo.');
      resetFileInput();
      return;
    }

    if (file.size > state.maxBytes) {
      showAlert(
        `That photo is ${formatBytes(file.size)}. Please choose one under ${formatBytes(state.maxBytes)}.`
      );
      resetFileInput();
      return;
    }

    if (file.size === 0) {
      showAlert('That file appears to be empty. Please choose another photo.');
      resetFileInput();
      return;
    }

    revokePreview();
    state.file = file;
    state.previewUrl = URL.createObjectURL(file);

    el.previewImage.src = state.previewUrl;
    el.previewImage.alt = `Preview of ${file.name}`;
    el.previewName.textContent = file.name;
    el.previewMeta.textContent = `${formatBytes(file.size)} · ${
      file.type ? file.type.replace('image/', '').toUpperCase() : fileExtension(file).toUpperCase()
    }`;

    el.photoPreview.hidden = false;
    el.dropzone.hidden = true;

    updateSubmitState();
  }

  function resetFileInput() {
    if (el.photoInput) el.photoInput.value = '';
  }

  function revokePreview() {
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = '';
    }
  }

  function clearSelection() {
    if (state.busy) return;

    revokePreview();
    resetFileInput();
    state.file = null;

    el.previewImage.removeAttribute('src');
    el.photoPreview.hidden = true;
    el.dropzone.hidden = false;
    el.dropzone.classList.remove('is-dragover');

    updateSubmitState();
    el.dropzone.focus({ preventScroll: true });
  }

  /* ---------------------------------------------------------------- cooldown */

  function startCooldown(until, reason) {
    const timestamp = Number(until);

    state.cooldownUntil =
      Number.isFinite(timestamp) && timestamp > Date.now()
        ? timestamp
        : Date.now() + state.cooldownMinutes * 60 * 1000;
    state.cooldownReason = reason === 'network' ? 'network' : 'visitor';

    if (state.cooldownTimer) {
      window.clearInterval(state.cooldownTimer);
      state.cooldownTimer = null;
    }

    if (reason === 'network') {
      el.cooldownTitle.textContent = 'The gallery is taking a short break';
      el.cooldownText.textContent =
        'A lot of moments arrived from this network at once. Please try again shortly.';
    } else {
      el.cooldownTitle.textContent = 'You are in a sharing cooldown';
      el.cooldownText.textContent =
        'To keep the gallery fair, each visitor can share one photo every 30 minutes.';
    }

    el.cooldownBanner.hidden = false;
    updateCooldown();
    state.cooldownTimer = window.setInterval(updateCooldown, 1000);
  }

  function clearCooldown() {
    state.cooldownUntil = 0;
    state.cooldownReason = 'visitor';

    if (state.cooldownTimer) {
      window.clearInterval(state.cooldownTimer);
      state.cooldownTimer = null;
    }

    el.cooldownBanner.hidden = true;
    el.cooldownText.textContent = 'Please wait before uploading another moment.';
  }

  function updateCooldown() {
    const remaining = state.cooldownUntil - Date.now();

    if (remaining <= 0) {
      clearCooldown();
      el.successCooldown.textContent = '';
      el.shareAnotherBtn.disabled = false;
      updateDropzoneAvailability();
      updateSubmitState();
      return;
    }

    const wait = formatDuration(remaining);

    if (state.cooldownReason === 'network') {
      el.cooldownText.textContent = `This network has reached its sharing limit. Try again in ${wait}.`;
    } else {
      el.cooldownText.textContent = `You can share another moment in ${wait}.`;
    }

    if (!el.successPanel.hidden) {
      el.successCooldown.textContent = `You can share another moment in ${wait}.`;
    }

    el.shareAnotherBtn.disabled = true;
    updateDropzoneAvailability();
    updateSubmitState();
  }

  function updateDropzoneAvailability() {
    const disabled = state.busy || isCoolingDown();
    el.dropzone.classList.toggle('is-disabled', disabled);
    el.dropzone.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  function updateDropzoneHint() {
    if (!el.dropzoneHint) return;
    el.dropzoneHint.textContent = `or click to browse. JPEG, PNG or WebP, up to ${formatBytes(state.maxBytes)}.`;
  }

  /* -------------------------------------------------------------- form state */

  function updateCaptionCount() {
    if (!el.captionCount || !el.caption) return;

    const count = el.caption.value.length;
    el.captionCount.textContent = String(count);
    el.captionCount.parentElement.classList.toggle('is-near-limit', count > 140);
  }

  function updateSubmitState() {
    if (!el.submitBtn) return;

    const canSubmit =
      state.apiAvailable &&
      !state.busy &&
      !isCoolingDown() &&
      Boolean(state.file) &&
      Boolean(el.consent.checked);

    el.submitBtn.disabled = !canSubmit;
    updateDropzoneAvailability();
  }

  function setBusy(isBusy) {
    state.busy = isBusy;

    el.submitBtn.classList.toggle('is-busy', isBusy);
    el.submitBtn.setAttribute('aria-busy', isBusy ? 'true' : 'false');
    el.submitLabel.textContent = isBusy ? 'Sending…' : 'Send for review';

    updateSubmitState();
  }

  /* ---------------------------------------------------------------- status */

  function scheduleStatusRetry() {
    if (state.statusRetryTimer) return;
    state.statusRetryTimer = window.setTimeout(() => {
      state.statusRetryTimer = null;
      refreshStatus();
    }, 10000);
  }

  async function refreshStatus() {
    try {
      const response = await fetch('/api/moments/status', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: apiHeaders()
      });

      if (!response.ok) throw new Error(`Status request failed with ${response.status}`);

      const status = await response.json();

      if (Number.isFinite(status.maxUploadBytes) && status.maxUploadBytes > 0) {
        state.maxBytes = status.maxUploadBytes;
        updateDropzoneHint();
      }

      if (Number.isFinite(status.cooldownMinutes) && status.cooldownMinutes > 0) {
        state.cooldownMinutes = status.cooldownMinutes;
      }

      state.apiAvailable = true;

      if (state.statusRetryTimer) {
        window.clearTimeout(state.statusRetryTimer);
        state.statusRetryTimer = null;
      }
      if (state.statusAlertShown) {
        state.statusAlertShown = false;
        clearAlert();
      }

      if (status.canUpload === false && status.nextAllowedAt) {
        startCooldown(new Date(status.nextAllowedAt).getTime(), status.reason);
      } else if (status.retryAfterSeconds > 0) {
        startCooldown(Date.now() + status.retryAfterSeconds * 1000, status.reason);
      } else {
        clearCooldown();
      }
    } catch (error) {
      state.apiAvailable = false;
      state.statusAlertShown = true;
      // A single failed status check (flaky network, a cold start, a deploy
      // in progress) must not brick the page until a manual reload: keep
      // retrying in the background and re-enable the form on success.
      showAlert(
        'The sharing service is not reachable right now. You can still choose a photo — we will keep reconnecting automatically.'
      );
      scheduleStatusRetry();
    } finally {
      updateSubmitState();
    }
  }

  /* ---------------------------------------------------------------- submit */

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => resolve(reader.result);
      reader.onerror = () =>
        reject(new Error('That file could not be read. Please try another photo.'));
      reader.readAsDataURL(file);
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (state.busy) return;
    clearAlert();

    if (!state.apiAvailable) {
      await refreshStatus();
      if (!state.apiAvailable) {
        showAlert('The sharing service is not reachable right now. Please try again in a moment.');
        return;
      }
    }

    if (!state.file) {
      showAlert('Please choose a photo first.');
      return;
    }

    const caption = el.caption.value.trim();

    if (caption.length < 3) {
      showAlert('Please add a short caption so visitors know what the moment shows.');
      el.caption.focus();
      return;
    }

    if (!el.consent.checked) {
      showAlert('Please confirm that you have permission to share this photo.');
      el.consent.focus();
      return;
    }

    if (isCoolingDown()) {
      showAlert('Your sharing cooldown is still active. Please wait for the timer to finish.');
      return;
    }

    setBusy(true);

    try {
      const dataUrl = await readAsDataUrl(state.file);

      const response = await fetch('/api/moments', {
        method: 'POST',
        credentials: 'same-origin',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          image: dataUrl,
          caption,
          contributor: el.contributor.value.trim(),
          consent: true,
          website: el.website ? el.website.value : ''
        })
      });

      let data = {};

      try {
        data = await response.json();
      } catch (error) {
        data = {};
      }

      if (response.status === 429) {
        const until = data.nextAllowedAt
          ? new Date(data.nextAllowedAt).getTime()
          : Date.now() + (Number(data.retryAfterSeconds) || state.cooldownMinutes * 60) * 1000;

        startCooldown(until, data.reason);
        showAlert(data.message || 'Please wait before sharing another moment.');
        return;
      }

      if (!response.ok) {
        if (response.status === 413) {
          showAlert('That image is larger than the upload limit. Please choose a smaller photo.');
        } else if (response.status === 415) {
          showAlert('Please choose a JPEG, PNG, or WebP photo.');
        } else if (data.message) {
          showAlert(data.message);
        } else {
          showAlert('We could not send that moment right now. Please try again.');
        }

        return;
      }

      showSuccess(data);
    } catch (error) {
      showAlert(
        error && error.message
          ? error.message
          : 'We could not reach the sharing service. Check your connection and try again.'
      );
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------------------------------------- success */

  function showSuccess(data) {
    if (data.message) {
      el.successMessage.textContent = data.message;
    }

    el.uploadPanel.hidden = true;
    el.successPanel.hidden = false;

    const nextAllowedAt = data.nextAllowedAt
      ? new Date(data.nextAllowedAt).getTime()
      : Date.now() + state.cooldownMinutes * 60 * 1000;

    startCooldown(nextAllowedAt, 'visitor');

    el.successPanel.focus({ preventScroll: true });
    el.successPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function startAnother() {
    if (state.busy || isCoolingDown()) return;

    el.successPanel.hidden = true;
    el.uploadPanel.hidden = false;

    el.momentForm.reset();
    updateCaptionCount();
    clearSelection();
    clearAlert();

    el.caption.focus({ preventScroll: true });
    el.uploadPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
})();
