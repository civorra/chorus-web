/**
 * server/routes/eca.js — Santé et infos du serveur ECA
 *
 *   GET /api/eca/health  → ping eca-server + latence
 *   GET /api/eca/info    → configuration ECA exposée au frontend
 */
'use strict';

const { Router } = require('express');
const fs = require('fs');
const { execFile } = require('child_process');
const eca = require('../../eca-client');
const { latencyHistory, recordLatency } = require('../state');
const { PERL } = require('../helpers/perl');

const router = Router();

// ── Helper — exécute `perl -e '<code>'` et résout stdout.trim() ─────────
function perlEval(code) {
  return new Promise((resolve, reject) => {
    execFile(PERL, ['-e', code], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.toString().trim() || err.message));
      resolve(stdout.toString().trim());
    });
  });
}

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
    res.json({ ok: false, error: err.message, latencyMs, history: latencyHistory.slice() });
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

// ── GET /api/engine/version ───────────────────────────────────
// Version réelle de Chorus::Engine installée nativement dans ce conteneur
// (lib/Chorus.pm $VERSION, cf. Dockerfile § make install) + vérification
// que Chorus::Engine se charge sans erreur (healthcheck du module Perl,
// indépendant de eca-server — voir chorus-web.js § refreshEngineBadge).
router.get('/version', async (req, res) => {
  let version = null;
  let engineOk = false;
  let installedAt = null;
  let error = null;

  try {
    version = await perlEval('use Chorus; print $Chorus::VERSION;');
  } catch (e) {
    error = `Chorus.pm : ${e.message}`;
  }

  try {
    await perlEval('use Chorus::Engine; 1;');
    engineOk = true;
  } catch (e) {
    error = (error ? error + ' · ' : '') + `Chorus::Engine : ${e.message}`;
  }

  try {
    const modPath = await perlEval('use Chorus; print $INC{"Chorus.pm"};');
    if (modPath) {
      const stat = fs.statSync(modPath);
      installedAt = stat.mtime.toISOString();
    }
  } catch { /* installedAt reste null si introspection impossible */ }

  res.json({ ok: !!version && engineOk, version, engineOk, installedAt, error });
});

module.exports = router;
