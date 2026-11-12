'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { loadProjectEnv } = require('../lib/env');

test('Neon .env.local is loaded ahead of .env without overriding hosting variables', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'labroute-env-'));
  const keys = ['LABROUTE_TEST_URL', 'LABROUTE_TEST_HOSTED', 'LABROUTE_TEST_FALLBACK'];
  const saved = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.LABROUTE_TEST_HOSTED = 'hosting-wins';
    await fs.writeFile(path.join(root, '.env.local'), 'LABROUTE_TEST_URL="local-wins"\nLABROUTE_TEST_HOSTED=file-value\n');
    await fs.writeFile(path.join(root, '.env'), 'LABROUTE_TEST_URL=older-value\nLABROUTE_TEST_FALLBACK=from-env\n');
    loadProjectEnv(root);
    assert.equal(process.env.LABROUTE_TEST_URL, 'local-wins');
    assert.equal(process.env.LABROUTE_TEST_HOSTED, 'hosting-wins');
    assert.equal(process.env.LABROUTE_TEST_FALLBACK, 'from-env');
  } finally {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    await fs.rm(root, { recursive: true, force: true });
  }
});
