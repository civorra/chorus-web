/**
 * server/routes/reports.js — Lecture et export de rapports
 *
 *   GET /api/sandboxes/:sbId/entities/:entityId/projects/:projId/reports/:filename
 *   GET /api/sandboxes/:sbId/entities/:entityId/projects/:projId/reports/:filename/export/:format
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Router } = require('express');
const { spawn } = require('child_process');
const chorus = require('../../chorus');

const router = Router({ mergeParams: true });

const BASE = '/sandboxes/:sbId/entities/:entityId/projects/:projId/reports';

router.get(`${BASE}/:filename`, (req, res) => {
  const { sbId, entityId, projId, filename } = req.params;
  if (!/^[\w\-\.]+\.(md|org)$/.test(filename)) {
    return res.status(400).json({ ok: false, error: 'Nom de fichier invalide' });
  }
  try {
    const content = chorus.readReport(sbId, entityId, projId, filename);
    if (!content) return res.status(404).json({ ok: false, error: 'Rapport introuvable' });
    const ct = filename.endsWith('.org') ? 'text/plain' : 'text/markdown';
    res.type(ct).send(content);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get(`${BASE}/:filename/export/:format`, (req, res) => {
  const { sbId, entityId, projId, filename, format } = req.params;
  if (!/^[\w\-\.]+\.(md|org)$/.test(filename)) {
    return res.status(400).json({ ok: false, error: 'Nom de fichier invalide' });
  }
  if (!['html', 'pdf'].includes(format)) {
    return res.status(400).json({ ok: false, error: `Format invalide : ${format} (html|pdf)` });
  }

  let content;
  try {
    content = chorus.readReport(sbId, entityId, projId, filename);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  if (!content) return res.status(404).json({ ok: false, error: 'Rapport introuvable' });

  const isOrg   = filename.endsWith('.org');
  const tmpDir  = fs.mkdtempSync(path.join(require('os').tmpdir(), 'chorus-export-'));
  const ext     = isOrg ? '.org' : '.md';
  const baseName = filename.replace(/\.(md|org)$/, '');
  const srcPath  = path.join(tmpDir, `${baseName}${ext}`);
  const outPath  = path.join(tmpDir, `${baseName}.${format}`);

  let chorusHome;
  try { chorusHome = chorus.CHORUS_HOME(); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }

  // ⚠️ "engine" en minuscule — le vrai dossier dans /chorus est "engine",
  // pas "Engine" (confirmé 2026-10-17, même piège que CHORUS_ENGINE_HOME
  // dans docker-compose.yml/.env — voir investigation badge engine OFFLINE).
  // org2html/org2pdf utilisent la même interface que md2html/md2pdf
  // (python3 <script> <input> <output>) — aucune autre différence.
  const scriptName = isOrg
    ? (format === 'pdf' ? 'org2pdf.py' : 'org2html.py')
    : (format === 'pdf' ? 'md2pdf.py'  : 'md2html.py');
  const script  = path.join(chorusHome, 'engine', 'scripts', scriptName);
  const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };

  try {
    fs.writeFileSync(srcPath, content, 'utf8');
  } catch (e) {
    cleanup();
    return res.status(500).json({ ok: false, error: `Écriture du fichier temporaire impossible : ${e.message}` });
  }

  const proc = spawn('python3', [script, srcPath, outPath]);
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d.toString(); });

  proc.on('close', code => {
    if (code !== 0 || !fs.existsSync(outPath)) {
      cleanup();
      return res.status(500).json({ ok: false, error: `Conversion ${format} échouée (code ${code}) : ${stderr.slice(-500)}` });
    }
    res.download(outPath, `${baseName}.${format}`, (err) => {
      cleanup();
      if (err && !res.headersSent) {
        res.status(500).json({ ok: false, error: `Téléchargement échoué : ${err.message}` });
      }
    });
  });

  proc.on('error', err => {
    cleanup();
    if (!res.headersSent) res.status(500).json({ ok: false, error: `Impossible de lancer python3 : ${err.message}` });
  });
});

module.exports = router;
