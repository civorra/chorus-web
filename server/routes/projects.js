/**
 * server/routes/projects.js — Import, run.pl, chorus-check, chat, run-report
 *
 *   POST /api/sandboxes/:sbId/entities/:entityId/projects/import
 *   POST /api/sandboxes/:sbId/entities/:entityId/projects/:projId/run
 *   GET  /api/sandboxes/:sbId/entities/:entityId/projects/:projId/check
 *   POST /api/sandboxes/:sbId/entities/:entityId/projects/:projId/chat
 *   GET  /api/sandboxes/:sbId/entities/:entityId/projects/:projId/run-report
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Router } = require('express');
const multer = require('multer');
const chorus  = require('../../chorus');
const prompts = require('../../prompts');
const eca     = require('../../eca-client');
const { sseInit, sseSend, sseDone, sseError } = require('../helpers/sse');
const { spawnPerl } = require('../helpers/perl');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-5';

const upload = multer({
  dest: path.join(require('os').tmpdir(), 'chorus-uploads'),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const router = Router();

// ── POST .../projects/import ──────────────────────────────────────────────
router.post(
  '/sandboxes/:sbId/entities/:entityId/projects/import',
  upload.single('file'),
  (req, res) => {
    sseInit(res);
    const { sbId, entityId } = req.params;
    const projId    = req.body.projId || `proj-${Date.now()}`;
    const llmModel  = req.body.model  || MODEL;
    const uploadedFile = req.file;

    if (!uploadedFile) return sseError(res, 'Fichier manquant');
    if (!entityId)     return sseError(res, 'entityId manquant dans l\'URL');

    let sbPath;
    try { sbPath = path.join(chorus.SANDBOXES_DIR(), sbId); }
    catch (e) { return sseError(res, e.message); }

    const entityPath = path.join(sbPath, 'workspace', entityId);
    const srcDir     = path.join(entityPath, 'sources', projId);
    fs.mkdirSync(srcDir, { recursive: true });

    const ext      = path.extname(uploadedFile.originalname) || '.pdf';
    const destFile = path.join(srcDir, `source${ext}`);
    fs.renameSync(uploadedFile.path, destFile);

    sseSend(res, 'log', { line: `→ Source : ${uploadedFile.originalname} → workspace/${entityId}/sources/${projId}/source${ext}` });
    sseSend(res, 'log', { line: `→ Lancement chorus-import-project …` });

    const args = [
      'chorus-import-project.pl',
      '--input',  destFile,
      '--output', srcDir,
      '--id',     projId,
      '--ctx',    entityId,
      '--model',  llmModel,
    ];

    spawnPerl(args, chorus.CHORUS_HOME(), res, () => {
      try {
        const proj = chorus.scanProject(entityPath, projId);
        sseSend(res, 'log', { line: `✓ Import terminé — ${proj.frames} frames extraites` });
        sseDone(res, { project: proj });
      } catch {
        sseDone(res, { project: { id: projId, state: 'imported' } });
      }
    });
  }
);

// ── POST .../projects/:projId/run ─────────────────────────────────────────
router.post('/sandboxes/:sbId/entities/:entityId/projects/:projId/run', (req, res) => {
  sseInit(res);
  const { sbId, entityId, projId } = req.params;

  let sbPath;
  try { sbPath = path.join(chorus.SANDBOXES_DIR(), sbId); }
  catch (e) { return sseError(res, e.message); }

  const entityPath      = path.join(sbPath, 'workspace', entityId);
  const runPl           = path.join(sbPath, 'run.pl');
  const flatProjectFile = path.join(entityPath, `${projId}.json`);
  const legacyFrames    = path.join(entityPath, 'sources', projId, 'frames.pl');

  let inputFile = null;
  if (fs.existsSync(flatProjectFile))    inputFile = flatProjectFile;
  else if (fs.existsSync(legacyFrames)) inputFile = legacyFrames;
  else return sseError(res, `Projet introuvable : ni ${projId}.json ni sources/${projId}/frames.pl`);

  if (!fs.existsSync(runPl)) {
    return sseError(res, `run.pl introuvable à la racine du sandbox — générez-le via chorus-check`);
  }

  sseSend(res, 'log', { line: `→ perl run.pl ${inputFile}` });

  spawnPerl(['run.pl', inputFile], sbPath, res, () => {
    const candidateDirs = [
      path.join(entityPath, 'reports'),
      path.join(sbPath, 'reports'),
    ];

    let reportFile = null, reportDir = null, reportData = null;

    outer:
    for (const dir of candidateDirs) {
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => f.startsWith('run-report-') && f.endsWith('.json')).sort(); }
      catch { continue; }

      for (let i = files.length - 1; i >= 0; i--) {
        try {
          const json = JSON.parse(fs.readFileSync(path.join(dir, files[i]), 'utf8'));
          if (json.project_file !== inputFile) continue;
          reportFile = files[i]; reportDir = dir;
          reportData = {
            verdict:      json.pipeline_solved ? 'SOLVED' : 'FAILED',
            totalFrames:  json.n_total ?? 0,
            conformes:    json.n_conforme ?? 0,
            nonConformes: json.n_non_conforme ?? 0,
            aConfirmer:   json.n_incertain ?? 0,
            norm: null,
            date: (json.generated_at || '').slice(0, 10) || null,
          };
          break outer;
        } catch {}
      }
    }

    if (reportFile) {
      const relDir = path.relative(sbPath, reportDir) || '.';
      sseSend(res, 'log', { line: `✓ Rapport généré : ${relDir}/${reportFile}` });
      sseSend(res, 'log', { line: `  Verdict : ${reportData.verdict} — ${reportData.conformes}/${reportData.totalFrames} CONFORMES` });
    } else {
      sseSend(res, 'log', { line: `⚠ Aucun run-report-*.json trouvé pour project_file=${inputFile}`, level: 'warn' });
    }

    sseDone(res, { reportFile, reportData });
  });
});

// ── GET .../projects/:projId/check ────────────────────────────────────────
router.get('/sandboxes/:sbId/entities/:entityId/projects/:projId/check', async (req, res) => {
  sseInit(res);
  const { sbId, entityId, projId } = req.params;
  const action = (req.query.action || 'summary').toLowerCase();

  if (!['summary', 'explain', 'complete-report'].includes(action)) {
    return sseError(res, `action invalide : ${action} (summary | explain | complete-report)`);
  }

  let sbPath;
  try { sbPath = path.join(chorus.SANDBOXES_DIR(), sbId); }
  catch (e) { return sseError(res, e.message); }

  const repDir    = path.join(sbPath, 'workspace', entityId, 'reports');
  const inputFile = req.query.input || null;
  let reportContent = null, reportFile = null;

  try {
    const allFiles = fs.readdirSync(repDir).filter(f => f.includes(projId)).sort();
    if (action === 'complete-report') {
      const explainFiles = allFiles.filter(f => f.startsWith('explain-') && f.endsWith('.md'));
      reportFile = inputFile && explainFiles.includes(inputFile) ? inputFile : explainFiles.pop();
      if (reportFile) reportContent = fs.readFileSync(path.join(repDir, reportFile), 'utf8');
      if (!reportContent) {
        const runFiles = allFiles.filter(f =>
          (f.startsWith('compliance-report-') || f.startsWith('pipeline-out-')) && f.endsWith('.md'));
        reportFile = runFiles.pop();
        if (reportFile) reportContent = fs.readFileSync(path.join(repDir, reportFile), 'utf8');
      }
    } else {
      const runFiles = allFiles.filter(f =>
        (f.startsWith('compliance-report-') || f.startsWith('pipeline-out-')) && f.endsWith('.md'));
      reportFile = runFiles.pop();
      if (reportFile) reportContent = fs.readFileSync(path.join(repDir, reportFile), 'utf8');
    }
  } catch {}

  if (!reportContent) {
    const hint = action === 'complete-report'
      ? `Aucun rapport --explain trouvé pour ${projId} — lancez chorus-check --explain d'abord`
      : `Aucun rapport de conformité trouvé pour ${projId} — lancez run.pl d'abord`;
    return sseError(res, hint);
  }

  const systemPrompt = action === 'summary' ? prompts.PROMPT_SUMMARY
    : action === 'explain' ? prompts.PROMPT_EXPLAIN
    : prompts.PROMPT_COMPLETE_REPORT;
  const outputLabel = action === 'complete-report' ? 'complete-report' : action;

  sseSend(res, 'log', { line: `→ chorus-check --${action} via eca-server (source: ${reportFile || '?'})` });

  const chatId  = `check-${sbId}-${entityId}-${projId}-${action}-${Date.now()}`;
  const message = `${systemPrompt}\n\n---\n\n${reportContent}`;

  try {
    const chat = await eca.promptAndWait(chatId, message, {
      onTick: () => sseSend(res, 'log', { line: `… en attente de la réponse ECA (chat ${chatId})` }),
    });
    if (chat.status === 'error') return sseError(res, `eca-server erreur pour le chat ${chatId}`);

    const fullText = eca.lastAssistantText(chat);
    sseSend(res, 'chunk', { text: fullText });

    const filename = chorus.writeCheckReport(sbId, entityId, projId, outputLabel, fullText);
    sseSend(res, 'log', { line: `✓ Rapport sauvegardé : ${filename}` });
    sseDone(res, { filename, action });
  } catch (err) {
    sseError(res, `Erreur eca-server : ${err.message}`);
  }
});

// ── POST .../projects/:projId/chat ────────────────────────────────────────
router.post('/sandboxes/:sbId/entities/:entityId/projects/:projId/chat', async (req, res) => {
  const { sbId, entityId, projId } = req.params;
  const { message } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: 'message manquant' });

  let context = '';
  try {
    const sbPath = path.join(chorus.SANDBOXES_DIR(), sbId);
    const repDir = path.join(sbPath, 'workspace', entityId, 'reports');
    const files  = fs.readdirSync(repDir).filter(f => f.includes(projId) && f.endsWith('.md')).sort();
    for (const f of files) {
      const content = fs.readFileSync(path.join(repDir, f), 'utf8');
      context += `\n\n---\n## ${f}\n\n${content}`;
      if (context.length > 40000) break;
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }

  const chatId = `chat-${sbId}-${entityId}-${projId}`;
  const fullMessage = context
    ? `${prompts.PROMPT_CHAT}\n\nVoici les rapports Chorus pour ce projet :\n${context}\n\n---\n\nQuestion : ${message}`
    : `${prompts.PROMPT_CHAT}\n\nQuestion : ${message}`;

  try {
    const chat = await eca.promptAndWait(chatId, fullMessage, { timeoutMs: 120000 });
    if (chat.status === 'error') {
      return res.status(502).json({ ok: false, error: `eca-server erreur pour le chat ${chatId}` });
    }
    res.json({ ok: true, reply: eca.lastAssistantText(chat) });
  } catch (err) {
    res.status(502).json({ ok: false, error: `Erreur eca-server : ${err.message}` });
  }
});

// ── GET .../projects/:projId/run-report ──────────────────────────────────
router.get('/sandboxes/:sbId/entities/:entityId/projects/:projId/run-report', (req, res) => {
  const { sbId, projId } = req.params;
  let sbPath;
  try { sbPath = path.join(chorus.SANDBOXES_DIR(), sbId); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }

  try {
    const index   = chorus.buildRunReportIndex(sbPath);
    const entries = index.get(`${projId}.json`);
    if (!entries || !entries.length) {
      return res.status(404).json({ ok: false, error: `Aucun run-report trouvé pour ${projId}` });
    }
    const entry = entries[entries.length - 1];
    res.json({ ok: true, file: entry.file, data: entry.data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
