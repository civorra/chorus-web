/**
 * server/routes/scan.js — Scan sandboxes + corpus KB
 *
 *   GET /api/scan                              → scan global
 *   GET /api/sandboxes/:sbId                   → scan sandbox individuel
 *   GET /api/sandboxes/:sbId/corpus            → corpus + modélisation KB
 *   GET /api/sandboxes/:sbId/agents/:slug/org  → contenu brut agent/<slug>.org
 */
'use strict';

const { Router } = require('express');
const chorus = require('../../chorus');

const router = Router();

router.get('/scan', (req, res) => {
  try {
    const sandboxes = chorus.scanAll();
    res.json({ ok: true, sandboxes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/sandboxes/:sbId', (req, res) => {
  try {
    const sb = chorus.scanSandbox(req.params.sbId);
    res.json({ ok: true, sandbox: sb });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/sandboxes/:sbId/corpus', (req, res) => {
  try {
    const corpus = chorus.scanSandboxCorpus(req.params.sbId);
    res.json({ ok: true, corpus });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/sandboxes/:sbId/agents/:slug/org', (req, res) => {
  try {
    const content = chorus.readAgentOrgFile(req.params.sbId, req.params.slug);
    if (!content) return res.status(404).json({ ok: false, error: 'Fichier KB agent introuvable' });
    res.type('text/plain').send(content);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
