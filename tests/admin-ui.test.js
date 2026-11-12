'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function page() {
  const status = { textContent: '', classList: { remove() {} } };
  const saved = new Map();
  const sandbox = {
    console,
    Date,
    document: { getElementById: (id) => id === 'pendingStatus' ? status : null, addEventListener() {} },
    window: { location: {} },
    sessionStorage: { getItem() { return 'true'; }, setItem() {}, removeItem() {} },
    localStorage: { setItem: (key, value) => saved.set(key, value) },
    fetch: async () => { throw new Error('offline'); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js/admin.js'), 'utf8'), sandbox);
  return { sandbox, saved, status };
}

test('the review card offers Approve/Reject, not download/commit instructions', () => {
  const { sandbox } = page();
  const container = { innerHTML: '' };
  const count = { textContent: '' };
  sandbox.renderPendingUploads(container, count, [{ id: 'moment-test', caption: '<script>unsafe</script>', contributor: 'A visitor' }], 8);
  assert.equal(count.textContent, '1');
  assert.match(container.innerHTML, /data-action="approve"/);
  assert.match(container.innerHTML, /data-action="reject"/);
  assert.match(container.innerHTML, />Approve</);
  assert.match(container.innerHTML, />Reject</);
  assert.doesNotMatch(container.innerHTML, /Commit both|Download the photo|content\/gallery\.json/);
  assert.doesNotMatch(container.innerHTML, /<script>/);
  assert.match(container.innerHTML, /&lt;script&gt;/);
});

test('an offline API does not fall back to publicly fetching admin password hashes', async () => {
  const { sandbox } = page();
  const paths = [];
  sandbox.fetch = async (url) => { paths.push(url); throw new Error('offline'); };
  const result = await sandbox.loginWithServer('admin@example.com', 'not-a-real-password');
  assert.equal(result.ok, false);
  assert.match(result.message, /unavailable/);
  assert.deepEqual(paths, ['/api/admin/login']);
  assert.equal(sandbox.loginWithBrowserData, undefined);
});

test('browser display state cannot authenticate an unavailable admin session', async () => {
  const { sandbox, status } = page();
  await sandbox.guardDashboard();
  assert.match(status.textContent, /review service is unavailable/);
});

test('successful approval notifies already-open gallery tabs', async () => {
  const { sandbox, saved, status } = page();
  sandbox.fetch = async (url, options) => {
    assert.equal(url, '/api/admin/pending/moment-test/approve');
    assert.equal(options.method, 'POST');
    return { status: 200, ok: true, json: async () => ({ ok: true, message: 'Approved. The photo is now image 1 in the gallery.' }) };
  };
  const button = { disabled: false, closest() { return null; } };
  await sandbox.reviewPending('moment-test', 'approve', button);
  assert.ok(saved.has('labroute-gallery-updated'));
  assert.match(status.textContent, /image 1/);
});
