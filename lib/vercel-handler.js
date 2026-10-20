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

  // Vercel's filesystem routes for plain (non-Next.js) functions do not match
  // multi-segment paths against an api/[...path].js catch-all: /api/health
  // was served, but nested routes such as /api/moments/status still got the
  // platform 404 after deployment. vercel.json therefore rewrites every
  // /api/<path> request to the one api/index.js Function as
  //   /api?__labroute_path=<path>
  // Restore the original request path here, preserving any real query
  // parameters (for example ?limit= on /api/moments/recent).
  let pathname = url.pathname;
  const rewrittenPath = url.searchParams.get('__labroute_path');
  if (rewrittenPath !== null) {
    const segments = rewrittenPath.split('/').filter(Boolean).map(encodeURIComponent);
    pathname = segments.length ? `/api/${segments.join('/')}` : '/api';
    url.searchParams.delete('__labroute_path');
  }
  const search = url.searchParams.toString() ? `?${url.searchParams.toString()}` : '';

  // vercel.json rewrites gallery photo requests that are not static files to
  // /api/moment-image/<filename>; turn them back into the public path the
  // static handler (and its Blob branch) understands.
  const momentImage = /^\/api\/moment-image\/(.+)$/.exec(pathname);
  if (momentImage) {
    req.url = `/assets/gallery/moments/${momentImage[1]}${search}`;
    return;
  }

  // Requests that land directly on the index Function arrive as
  // /api/index(.js) or bare /api.
  if (pathname === '/api/index' || pathname === '/api/index.js') {
    req.url = `/api${search}`;
    return;
  }

  if (pathname !== url.pathname || search !== url.search) {
    req.url = `${pathname}${search}`;
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
