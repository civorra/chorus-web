/**
 * server/routes/eca.js — Santé et infos du serveur ECA
 *
 *   GET /api/eca/health  → ping eca-server + latence
 *   GET /api/eca/info    → configuration ECA exposée au frontend
 */
'use strict';

const { Router } = require('express');
const eca = require('../../eca-client');
const { latencyHistory, recordLatency } = require('../state');

const router = Router();

// ── GET /api/eca/health ──────────────────────────────────────
router.get('/health', async (req, res) => {
  const start = Date.now();
  try {
    await eca.ecaRequest('/api/v1/chats', 'GET');
    const latencyMs = Date.now() - start;
    recordLatency(latencyMs);
    res.json({ ok: true, latencyMs, history: latencyHistory.slice() });
  } catch (err) {
    const latencyMs = Date.now() - start;
    const statusCode = err.statusCode || 503;
    res.json({
      ok: false,
      error: err.message,
      errorCode: statusCode,
      latencyMs,
      history: latencyHistory.slice(),
    });
  }
});

// ── GET /api/eca/info ────────────────────────────────────────
router.get('/info', async (req, res) => {
  let chatCount = null;
  try {
    const list = await eca.ecaRequest('/api/v1/chats', 'GET');
    chatCount = Array.isArray(list) ? list.length : null;
  } catch { /* chatCount reste null si eca-server injoignable */ }

  res.json({
    protocol:          'https (JSON-RPC/LSP-inspired) + SSE',
    serverUrl:         process.env.ECA_SERVER_URL || 'https://eca-server:7777',
    binary:            'eca (GraalVM native static binary)',
    defaultModel:      process.env.ECA_DEFAULT_MODEL || null,
    providerType:      process.env.ANTHROPIC_PROVIDER_TYPE || null,
    modelArchitect:    process.env.ECA_MODEL_ARCHITECT || null,
    modelCode:         process.env.ECA_MODEL_CODE || null,
    modelFast:         process.env.ECA_MODEL_FAST || null,
    workspaceFolders:  ['/chorus/Engine (chorus-engine)', '/chorus (chorus)'],
    activeChatCount:   chatCount,
    containerName:     process.env.ECA_CONTAINER_NAME || null,
  });
});

module.exports = router;
