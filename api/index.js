'use strict';

/**
 * The single Vercel Function behind every /api/* route on the deployed site.
 *
 * Do not "simplify" this back to an api/[...path].js catch-all: for plain
 * (non-Next.js) Vercel functions that filename only matched ONE path segment
 * in production (/api/health worked, nested routes such as
 * /api/moments/status returned Vercel's 404). Instead, vercel.json rewrites
 * all /api/<path> requests to this function, and lib/vercel-handler.js
 * restores the original path before the shared request handler runs.
 *
 * Keeping one function also means all API traffic shares warm-instance state
 * (mutexes, login attempts, ephemeral /tmp) consistently.
 */
module.exports = require('../lib/vercel-handler');
