'use strict';

/**
 * Catch-all Vercel Function for the LabRoute API.
 *
 * Matches every /api/<...> route the site calls — /api/moments/status,
 * /api/moments, /api/gallery, /api/health and the /api/admin/* review
 * endpoints — and hands them to the same handler `server.js` uses locally.
 * A single catch-all function (rather than one file per route) keeps all API
 * traffic in one Function, so warm instances share state consistently.
 *
 * The handler lives in lib/ so Vercel does not turn it into a second,
 * separately routed function.
 */
module.exports = require('../lib/vercel-handler');
