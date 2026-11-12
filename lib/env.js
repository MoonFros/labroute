'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Minimal .env loader. Values already present in the environment win, which
 * matches the behaviour of most hosting dashboards.
 */
function loadEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function loadProjectEnv(root = path.join(__dirname, '..')) {
  loadEnvFile(path.join(root, '.env.local'));
  loadEnvFile(path.join(root, '.env'));
}

module.exports = { loadEnvFile, loadProjectEnv };
