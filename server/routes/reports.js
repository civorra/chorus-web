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

const BASE = '/api/sandboxes/:sbId/entities/:entityId/projects/:projId/reports';

router.get(`${BASE}/:filename`, (req, res) => {
  const { sbId, entityId, projId, filename } = req.params;
  if (!/^[\w\-\.]+\.md$/.test(filename)) {
    return res.status(400).json({ ok: false, error: 'Nom de fichier invalide' });
  }
  try {
    const content = chorus.readReport(sbId, entityId, projId, filename);
    if (!content) return res.status(404).json({ ok: false, error: 'Rapport introuvable' });
    res.type('text/markdown').send(content);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get(`${BASE}/:filename/export/:format`, (req, res) => {
  const { sbId, entityId, projId, filename, format } = req.params;
  if (!/^[\w\-\.]+\.md$/.test(filename)) {
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

  const tmpDir   = fs.mkdtempSync(path.join(require('os').tmpdir(), 'chorus-export-'));
  const baseName = filename.replace(/\.md$/, '');
  const mdPath   = path.join(tmpDir, `${baseName}.md`);
  const outPath  = path.join(tmpDir, `${baseName}.${format}`);

  let chorusHome;
  try { chorusHome = chorus.CHORUS_HOME(); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }

  const script = path.join(chorusHome, 'Engine', 'scripts', format === 'pdf' ? 'md2pdf.py' : 'md2html.py');
  const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };

  try {
    fs.writeFileSync(mdPath, content, 'utf8');
  } catch (e) {
    cleanup();
    return res.status(500).json({ ok: false, error: `Écriture du fichier temporaire impossible : ${e.message}` });
  }

  const proc = spawn('python3', [script, mdPath, outPath]);
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
