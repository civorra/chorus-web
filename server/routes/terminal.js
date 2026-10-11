/**
 * server/routes/terminal.js — Terminal ECA interactif (SSE)
 *
 *   GET    /api/terminals/active
 *   POST   /api/sandboxes/:sbId/terminal
 *   POST   /api/sandboxes/:sbId/terminal/respond
 *   POST   /api/sandboxes/:sbId/terminal/stop
 *   DELETE /api/sandboxes/:sbId/terminal
 */
'use strict';

const path = require('path');
const { Router } = require('express');
const chorus = require('../../chorus');
const eca    = require('../../eca-client');
const { sseInit, sseSend, sseDone, sseError } = require('../helpers/sse');
const { activeTerminals } = require('../state');

const router = Router();

// ── GET /api/terminals/active ─────────────────────────────────────────────
router.get('/terminals/active', (req, res) => {
  const sessions = Array.from(activeTerminals.entries()).map(([sessionId, t]) => ({
    sessionId,
    sbId:        t.sbId,
    level:       t.level,
    entityId:    t.entityId || null,
    projId:      t.projId || null,
    reportFile:  t.reportFile || null,
    startedAt:   t.startedAt || null,
    elapsedMs:   t.startedAt ? Date.now() - t.startedAt : null,
    lastMessage: t.lastMessage || null,
  }));
  res.json({ ok: true, count: sessions.length, sessions });
});

// ── POST /api/sandboxes/:sbId/terminal ───────────────────────────────────
router.post('/sandboxes/:sbId/terminal', (req, res) => {
  sseInit(res);
  const { sbId } = req.params;
  const { level, entityId, projId, reportFile, sessionId, message } = req.body;

  if (!message || !sessionId) return sseError(res, 'message/sessionId manquant');
  if (!['sandbox', 'entity', 'project', 'report'].includes(level)) {
    return sseError(res, `level invalide : ${level}`);
  }

  (async () => {
    // ── Context block ──────────────────────────────────────────────────
    let contextBlock = '';
    try {
      const sb = chorus.scanSandbox(sbId);
      if (level === 'sandbox') {
        contextBlock = `Sandbox ${sbId} — norme ${sb.norm}. Entities : ${sb.entities.map(e => e.id).join(', ') || '(aucune)'}.`;
      } else if (level === 'entity') {
        const entity = sb.entities.find(e => e.id === entityId);
        const projs  = (entity && entity.projects) || [];
        contextBlock = `Entity ${entityId} (sandbox ${sbId}) — projets : ${projs.map(p => p.id).join(', ') || '(aucun)'}.`;
      } else if (level === 'project') {
        const entity = sb.entities.find(e => e.id === entityId);
        const proj   = entity && (entity.projects || []).find(p => p.id === projId);
        contextBlock = `Projet ${projId} (${sbId}/${entityId}) — ${proj ? `${proj.frames || 0} frames, verdict ${proj.verdict || '?'}` : '(détails indisponibles)'}.`;
      } else if (level === 'report') {
        const content = chorus.readReport(sbId, entityId, projId, reportFile) || '';
        contextBlock = `Rapport ${reportFile} (${sbId}/${entityId}/${projId}) :\n${content.slice(0, 8000)}`;
      }
    } catch (e) { contextBlock = `(contexte indisponible : ${e.message})`; }

    // ── chatId isolé par sessionId ─────────────────────────────────────
    const chatId = `eca-term-${sbId}-${sessionId}`;
    let agentsPrefix = '';
    try {
      const list  = await eca.ecaRequest('/api/v1/chats', 'GET');
      const isNew = !Array.isArray(list) || !list.find(c => c.id === chatId);
      if (isNew) {
        const chorusHome = chorus.CHORUS_HOME();
        agentsPrefix =
          `[Chorus ECA Terminal — sandbox: ${sbId}]\n` +
          `Workspace: ${chorusHome}. ` +
          `Engine AGENTS.md: ${path.join(chorusHome, 'Engine', 'AGENTS.md')}. ` +
          `Read it via your tools when needed to answer Chorus commands.\n\n`;
      }
    } catch { /* proceed without prefix */ }

    const DONE_INSTRUCTION =
      '\n\n[TERMINAL PROTOCOL — OBLIGATOIRE] ' +
      'Quand ta réponse est entièrement terminée — skill accompli, fichiers écrits, question répondue — ' +
      'tu dois écrire en toute dernière ligne, seule sur sa ligne, le mot exactement : DONE';

    const fullMessage =
      `${agentsPrefix}[Contexte ECA — niveau ${level}]\n${contextBlock}\n\nQuestion : ${message}` +
      DONE_INSTRUCTION;

    // ── Subscribe BEFORE sending ─────────────────────────────────────────
    let subReq = null, finished = false;

    const heartbeat = setInterval(() => {
      if (!finished) sseSend(res, 'ping', { t: Date.now() });
    }, 15000);

    const finish = (errMsg) => {
      if (finished) return;
      finished = true;
      activeTerminals.delete(sessionId);
      clearInterval(heartbeat);
      if (subReq) { try { subReq.destroy(); } catch {} }
      if (errMsg) sseError(res, errMsg);
      else sseDone(res, {});
    };

    const timeoutHandle = setTimeout(
      () => finish('timeout après 20 min — skill encore en cours côté ECA'),
      1_200_000
    );

    const { req: sReq, done } = eca.subscribeEcaEvents(chatId, {
      onChunk:   (text)     => { if (!finished) sseSend(res, 'chunk', { text }); },
      onAsk:     (payload)  => { if (!finished) sseSend(res, 'ask', payload); },
      onToolLog: (toolInfo) => { if (!finished) sseSend(res, 'tool', toolInfo); },
      onDone:    ()         => { clearTimeout(timeoutHandle); finish(); },
      onError:   (err)      => { clearTimeout(timeoutHandle); finish(`ECA events: ${err.message}`); },
    });
    subReq = sReq;
    activeTerminals.set(sessionId, {
      finish, chatId, sbId, level, entityId, projId, reportFile,
      startedAt:   Date.now(),
      lastMessage: message.length > 160 ? message.slice(0, 160) + '…' : message,
    });

    // ── Send the prompt ────────────────────────────────────────────────
    try {
      await eca.ecaRequest(
        `/api/v1/chats/${encodeURIComponent(chatId)}/prompt`, 'POST', { message: fullMessage }
      );
    } catch (err) {
      clearTimeout(timeoutHandle);
      finish(`Erreur POST prompt : ${err.message}`);
      return;
    }

    await done.catch(() => {});
    clearTimeout(timeoutHandle);
    finish();
  })().catch(err => sseError(res, err.message));
});

// ── POST /api/sandboxes/:sbId/terminal/respond ────────────────────────────
router.post('/sandboxes/:sbId/terminal/respond', async (req, res) => {
  const { sbId } = req.params;
  const { message, sessionId } = req.body;
  if (!message)   return res.status(400).json({ ok: false, error: 'message manquant' });
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId manquant' });
  const chatId = `eca-term-${sbId}-${sessionId}`;
  try {
    await eca.ecaRequest(`/api/v1/chats/${encodeURIComponent(chatId)}/prompt`, 'POST', { message });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── POST /api/sandboxes/:sbId/terminal/stop ───────────────────────────────
router.post('/sandboxes/:sbId/terminal/stop', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.json({ ok: true, cancelled: false });
  const t = activeTerminals.get(sessionId);
  if (t) {
    t.finish('annulé par l\'utilisateur');
    res.json({ ok: true, cancelled: true });
  } else {
    res.json({ ok: true, cancelled: false });
  }
});

// ── DELETE /api/sandboxes/:sbId/terminal ──────────────────────────────────
router.delete('/sandboxes/:sbId/terminal', async (req, res) => {
  const { sbId } = req.params;
  const { sessionId } = req.body || {};
  if (!sessionId) return res.json({ ok: true, deleted: false });
  const chatId = `eca-term-${sbId}-${sessionId}`;
  const t = activeTerminals.get(sessionId);
  if (t) t.finish('session terminal fermée par l\'utilisateur');
  try {
    await eca.ecaRequest(`/api/v1/chats/${encodeURIComponent(chatId)}`, 'DELETE');
    res.json({ ok: true, deleted: true });
  } catch (err) {
    res.json({ ok: true, deleted: false, error: err.message });
  }
});

module.exports = router;
