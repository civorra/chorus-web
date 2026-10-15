/**
 * server/routes/scan.js — Scan sandboxes + corpus KB
 *
 *   GET  /api/scan                              → scan global
 *   GET  /api/sandboxes/:sbId                   → scan sandbox individuel
 *   GET  /api/sandboxes/:sbId/corpus            → corpus + modélisation KB
 *   GET  /api/sandboxes/:sbId/agents/:slug/org  → contenu brut agent/<slug>.org
 *   POST /api/sandboxes/:sbId/entities          → crée une nouvelle entity
 *                                                  (workspace/<entity>/{sources,reports})
 */
'use strict';

const fs   = require('fs');
const path = require('path');
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

// ── POST /sandboxes/:sbId/entities ────────────────────────────────────────
//
// Crée une nouvelle entity dans le sandbox : simple matérialisation du
// dossier `workspace/<entityId>/` avec ses deux sous-dossiers vides
// `sources/` et `reports/` — aucun fichier de config n'est requis, le
// scanner (`chorus/scanner.js § scanSandbox`) détecte toute entity par
// simple listage de répertoire (`listDirs(workspacePath)`), donc la
// créer sur disque suffit à la faire apparaître au prochain scan.
router.post('/sandboxes/:sbId/entities', (req, res) => {
  try {
    const { sbId } = req.params;
    const label = (req.body && req.body.label || '').trim();
    if (!label) return res.status(400).json({ ok: false, error: 'Nom d\'entity manquant' });

    // Slugification identique à celle utilisée côté frontend pour les
    // sandboxes/contextes (cf. chorus-web.js § createSandbox) — minuscules,
    // alphanumérique, tirets, pas de tiret en tête/fin.
    const entityId = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!entityId) {
      return res.status(400).json({ ok: false, error: 'Ce nom ne produit aucun identifiant de dossier valide — utilisez au moins une lettre ou un chiffre.' });
    }

    let sbPath;
    try { sbPath = path.join(chorus.SANDBOXES_DIR(), sbId); }
    catch (e) { return res.status(500).json({ ok: false, error: e.message }); }

    if (!fs.existsSync(sbPath)) {
      return res.status(404).json({ ok: false, error: `Sandbox introuvable : ${sbId}` });
    }

    const entityPath = path.join(sbPath, 'workspace', entityId);
    if (fs.existsSync(entityPath)) {
      return res.status(409).json({ ok: false, error: `Une entity nommée "${entityId}" existe déjà dans ce sandbox.` });
    }

    fs.mkdirSync(path.join(entityPath, 'sources'), { recursive: true });
    fs.mkdirSync(path.join(entityPath, 'reports'), { recursive: true });

    res.json({ ok: true, entity: { id: entityId, label, path: `workspace/${entityId}` } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
