'use strict';

const { hmac, readJson, safeEqual, sha256 } = require('./util');

async function readAdmins(config) {
  if (config.database) return config.database.readAdmins();
  const data = await readJson(config.adminsFile, { admins: [] });
  const list = Array.isArray(data) ? data : data.admins;
  return Array.isArray(list) ? list : [];
}

async function verifyCredentials(config, email, password) {
  const normalisedEmail = String(email || '').trim().toLowerCase();
  if (!normalisedEmail || typeof password !== 'string' || !password) return null;

  const admins = await readAdmins(config);
  const hash = sha256(password);

  const admin = admins.find(
    (candidate) =>
      String(candidate?.email || '').trim().toLowerCase() === normalisedEmail &&
      safeEqual(String(candidate?.passwordCrypt || '').toLowerCase(), hash)
  );

  return admin ? { email: normalisedEmail } : null;
}

function createToken(config, email, now = Date.now()) {
  const payload = Buffer.from(
    JSON.stringify({
      sub: String(email).toLowerCase(),
      iat: now,
      exp: now + config.adminSessionTtlMs
    })
  ).toString('base64url');

  return `${payload}.${hmac(payload, config.secret)}`;
}

function verifyToken(config, token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = hmac(payload, config.secret);

  if (!safeEqual(signature, expected)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || typeof data.sub !== 'string' || !data.sub) return null;
    if (!Number.isFinite(data.exp) || data.exp <= now) return null;
    return { email: data.sub, expiresAt: data.exp };
  } catch {
    return null;
  }
}

module.exports = {
  createToken,
  readAdmins,
  verifyCredentials,
  verifyToken
};
