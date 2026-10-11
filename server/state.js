/**
 * server/state.js — État partagé entre les routers
 *
 * - activeTerminals : Map sessionId → { finish, chatId, sbId, … }
 * - latencyHistory  : ring buffer des latences ECA (pour /api/eca/health)
 */
'use strict';

// Terminaux ECA actifs (sessions SSE ouvertes).
// Partagé entre routes/terminal.js (spawn/stop/delete)
// et routes/eca.js (badge de comptage).
const activeTerminals = new Map();

// Ring buffer des latences ECA (30 dernières mesures).
const latencyHistory = [];
const LATENCY_HISTORY_MAX = 30;

function recordLatency(ms) {
  latencyHistory.push(ms);
  if (latencyHistory.length > LATENCY_HISTORY_MAX) latencyHistory.shift();
}

module.exports = { activeTerminals, latencyHistory, recordLatency };
