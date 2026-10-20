'use strict';

/**
 * Handles the bare /api route (the [...path] catch-all requires at least one
 * segment). All real endpoints are served by api/[...path].js; this simply
 * returns the API's JSON 404 instead of the static host's HTML 404.
 */
module.exports = require('../lib/vercel-handler');
