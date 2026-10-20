'use strict';

/**
 * Vercel Function entrypoint for the Lab Moments API.
 *
 * The production site is a static deployment on Vercel, which never starts
 * `server.js` — that is why every `/api/*` request used to return the static
 * host's 404 and the upload page reported the sharing service as unreachable.
 * The files in `api/` re-export this handler, so the exact same request
 * handling that `npm start` serves locally now runs as a Function.
 *
 * One app instance is created per warm Function instance and reused across
 * requests, which keeps the in-memory mutexes / login-attempt map — and, in
 * ephemeral mode, a consistent view of `/tmp` — for the instance's lifetime.
 */

const { createApp } = require('../server');

function normaliseUrl(req) {
  const rawUrl = typeof req.url === 'string' && req.url ? req.url : '/';

  let url;
  try {
    url = new URL(rawUrl, 'http://localhost');
  } catch {
    return;
  }

  // vercel.json rewrites gallery photo requests that are not static files to
  // /api/moment-image/<filename>; turn them back into the public path the
  // static handler (and its Blob branch) understands.
  const momentImage = /^\/api\/moment-image\/(.+)$/.exec(url.pathname);
  if (momentImage) {
    req.url = `/assets/gallery/moments/${momentImage[1]}${url.search}`;
    return;
  }

  // Requests that land on the bare index function arrive as /api/index(.js).
  if (url.pathname === '/api/index' || url.pathname === '/api/index.js') {
    req.url = `/api${url.search}`;
  }
}

function createVercelHandler(overrides = {}) {
  let app = null;

  function handler(req, res) {
    if (!app) app = createApp(overrides);
    normaliseUrl(req);
    return app.handler(req, res);
  }

  // Ask Vercel's Node runtime not to pre-parse request bodies: the shared
  // handler reads (and size-limits) the JSON stream itself. readJsonBody
  // also tolerates a pre-parsed `req.body` if helpers run anyway.
  handler.config = { api: { bodyParser: false } };

  return handler;
}

const handler = createVercelHandler();

module.exports = handler;
module.exports.createVercelHandler = createVercelHandler;
module.exports.config = handler.config;
