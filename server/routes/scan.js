/**
 * server/routes/scan.js — Scan sandboxes + corpus KB
 *
 *   GET  /api/scan                                    → scan global
 *   GET  /api/sandboxes/:sbId                         → scan sandbox individuel
 *   GET  /api/sandboxes/:sbId/corpus                  → corpus + modélisation KB
 *   GET  /api/sandboxes/:sbId/agents/:slug/org        → contenu brut agent/<slug>.org
 *   GET  /api/sandboxes/:sbId/rules/:slug/:filename   → contenu brut rules/<slug>/<filename>.yml
 *   POST /api/sandboxes/:sbId/entities                → crée une nouvelle entity
 *                                                        (workspace/<entity>/{sources,reports})
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

// Débloque un checkpoint resté en status "running" sans mise à jour depuis
// longtemps (session chorus-feed --unattended crashée — conteneur
// redémarré, process tué — avant d'avoir pu réécrire "waiting"/
// "stopped_max_passes"/"converged"). Déclenché par le bouton webapp
// "⚠️ Feed bloqué" (cf. chorus-web.js § isFeedStatusStaleRunning /
// FEED_RUNNING_STALE_MS) — jamais automatique, toujours un clic explicite.
//
// Sécurité serveur (ne pas se fier uniquement au client) : refuse si le
// fichier n'existe pas, si status n'est pas "running", ou si last_update
// est trop récent (< STALE_MS) — un vrai "running" en cours ne doit jamais
// être débloqué silencieusement.
const FEED_UNSTICK_STALE_MS = 10 * 60 * 1000; // garder en phase avec chorus-web.js
router.post('/sandboxes/:sbId/feed-status/unstick', (req, res) => {
  try {
    const { SANDBOXES_DIR } = require('../../chorus/fs');
    const sbPath = path.join(SANDBOXES_DIR(), req.params.sbId);
    const p = path.join(sbPath, '.chorus-unattended-state.json');
    if (!fs.existsSync(p)) {
      return res.status(404).json({ ok: false, error: 'Checkpoint introuvable' });
    }
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (d.status !== 'running') {
      return res.status(409).json({ ok: false, error: `status actuel = "${d.status}", pas "running" — rien à débloquer` });
    }
    const lastUpdateMs = d.last_update ? new Date(d.last_update).getTime() : NaN;
    if (Number.isNaN(lastUpdateMs) || (Date.now() - lastUpdateMs) <= FEED_UNSTICK_STALE_MS) {
      return res.status(409).json({ ok: false, error: 'last_update trop récent — une session est probablement réellement en cours' });
    }
    d.status = 'waiting';
    d.current_file = null;
    d.current_mode = null;
    fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf8');
    res.json({ ok: true });
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

// ── GET /sandboxes/:sbId/corpus-files ────────────────────────────────────
// Liste récursive de tous les fichiers non-cachés dans corpus/ et ses
// sous-dossiers. Utilisé par le pré-vol Pipeline Feed pour présenter la
// liste à l'utilisateur avant d'ouvrir le terminal ECA.
router.get('/sandboxes/:sbId/corpus-files', (req, res) => {
  const { SANDBOXES_DIR } = require('../../chorus/fs');
  try {
    const corpusRoot = path.join(SANDBOXES_DIR(), req.params.sbId, 'corpus');
    const NON_DOC = /\.(log|pyc|pyo|tmp|bak|swp)$/i;
    const files = [];
    function scan(dir, relBase) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const relPath = relBase ? `${relBase}/${e.name}` : e.name;
        const full    = path.join(dir, e.name);
        if (e.isDirectory()) { scan(full, relPath); }
        else if (!NON_DOC.test(e.name)) {
          let size = null;
          try { size = fs.statSync(full).size; } catch {}
          files.push({ name: e.name, relPath, size });
        }
      }
    }
    scan(corpusRoot, '');
    res.json({ ok: true, files });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /sandboxes/:sbId/feed-status ─────────────────────────────────────
// Lit .chorus-unattended-state.json du sandbox et retourne l'état normalisé.
// Appelé par le polling client toutes les N secondes pour mettre à jour le
// bouton "Confirmer → Feed" sans rechargement de page.
router.get('/sandboxes/:sbId/feed-status', (req, res) => {
  try {
    const { SANDBOXES_DIR } = require('../../chorus/fs');
    const sbPath = path.join(SANDBOXES_DIR(), req.params.sbId);
    const p = path.join(sbPath, '.chorus-unattended-state.json');
    if (!fs.existsSync(p)) return res.json({ ok: true, feedStatus: null });
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    res.json({ ok: true, feedStatus: {
      status:      d.status                           || 'waiting',
      converged:   !!d.converged,
      passesDone:  d.passes_done                      || 0,
      maxPasses:   d.max_passes                       || 0,
      coveragePct: d.coverage_pct                     || 0,
      pendingA:    (d.files_mode_a_pending || []).length,
      pendingB:    (d.files_mode_b_pending || []).length,
      nextAction:  d.next_action                      || null,
      // Structured counterparts to next_action's free text — see
      // chorus-feed.md § Step 4 / § Webapp integration. Kept in sync with
      // chorus/scanner.js's readFeedStatus() (two separate consumers of the
      // same checkpoint file, for the scan cache and the live polling route).
      newRulesThisPass:        d.new_rules_this_pass          || 0,
      suggestedNextFile:       d.suggested_next_file          || null,
      deferredUnchangedPasses: d.deferred_unchanged_passes    || 0,
      unresolvedDeferredNotes: d.unresolved_deferred_notes    || [],
      lastUpdate:  d.last_update                      || null,
    }});
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

// Lecture brute d'un fichier YAML de règle (rules/<slug>/<filename>.yml) —
// utilisé par le viewer "Rule catalog" pour basculer entre la définition
// .org d'une règle et son YAML exécuté. Toujours lecture seule.
router.get('/sandboxes/:sbId/rules/:slug/:filename', (req, res) => {
  try {
    const content = chorus.readRuleYamlFile(req.params.sbId, req.params.slug, req.params.filename);
    if (!content) return res.status(404).json({ ok: false, error: 'Fichier YAML de règle introuvable' });
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
