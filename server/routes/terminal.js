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

// ── Mapping skill/trigger → agent ECA attendu (Engine/TODO.org [#J] Axe 1)
// Miroir de la table Trigger → Skill → Agent documentée dans
// Engine/AGENTS.md § "Triggers and skills". Détection par mot-clé dans le
// message envoyé — volontairement simple (regex sur le nom du
// trigger/skill tel qu'il apparaît typiquement dans les commandes
// générées par l'UI, ex. "chorus-check sbId --summary") plutôt qu'un
// parsing structurel : les boutons UI envoient des commandes textuelles
// prévisibles (cf. chorus-web.js § ecaShowCmd), donc un matching simple
// suffit et reste facile à maintenir en miroir d'AGENTS.md.
// Ordre : du plus spécifique au plus générique — le premier match gagne.
const AGENT_BY_TRIGGER = [
  // architect — skills de modélisation/décision lourde
  { pattern: /\bchorus-(feed|pdf|word|excel|corpus-directives|corpus-scoping|check|schema-export|create-project|stress|strengthen|review-kb|showcase|complete-report)\b/, agent: 'architect' },
  { pattern: /\b(deep-cms6|deep-cms5|deep-otc|map-cms5|map-otc|warmup-cms5-mig|study-cms5|study-cms6|analyze-main|update-knowledge|review-adr|review-mr|review-branch|review-br|test-mr|fix-mr|inspect-branch|test-branch|test-br|report-ticket)\b/, agent: 'architect' },
  { pattern: /\btest-skborg\b/, agent: 'fast' },
  // fast — consultation/lecture seule
  { pattern: /\b(chorus-quickstart|prepare-ticket|prepare\s+NEWT|git-ctx|skills(\s+details)?|tag-rdiff)\b/, agent: 'fast' },
  // code — édition standard
  { pattern: /\bchorus-(import-project|audit-import)\b/, agent: 'code' },
  { pattern: /\b(select-mr|publish-review|inspect-mr|create-mr|cpan-release)\b/, agent: 'code' },
];

/** Déduit l'agent ECA attendu depuis le texte du message utilisateur, ou
 * null si aucun trigger connu n'est détecté (laisse alors l'agent du chat
 * inchangé — ne force rien pour les messages en langage naturel libre). */
function detectExpectedAgent(message) {
  for (const { pattern, agent } of AGENT_BY_TRIGGER) {
    if (pattern.test(message)) return agent;
  }
  return null;
}

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
    let chatAlreadyExists = false;
    try {
      const list  = await eca.ecaRequest('/api/v1/chats', 'GET');
      chatAlreadyExists = Array.isArray(list) && !!list.find(c => c.id === chatId);
      if (!chatAlreadyExists) {
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
      onToolLog: (toolInfo) => {
        if (finished) return;
        sseSend(res, 'tool', toolInfo);
        // Bandeau "Skill actif" (Engine/TODO.org [#J] Axe 3) — détecte un
        // appel à l'outil natif ECA "skill" (chargement d'un skill Chorus)
        // et maintient un historique court côté session pour permettre au
        // frontend d'afficher "skill actif" même après défilement du log
        // principal, y compris en cas de reconnexion SSE à une session
        // déjà en cours (voir activeTerminals.get(sessionId).skillHistory).
        if (toolInfo.isSkillLoad && toolInfo.skillName) {
          const t = activeTerminals.get(sessionId);
          if (t) {
            t.currentSkill = toolInfo.skillName;
            t.skillHistory = t.skillHistory || [];
            if (t.skillHistory[t.skillHistory.length - 1] !== toolInfo.skillName) {
              t.skillHistory.push(toolInfo.skillName);
            }
          }
          sseSend(res, 'skill', {
            name: toolInfo.skillName,
            history: t ? t.skillHistory : [toolInfo.skillName],
          });
        }
        // Panneau de tâches (Engine/TODO.org [#J] Axe 4) — ECA fournit déjà
        // l'état consolidé complet de la todo-list à chaque appel eca__task
        // (classifyToolCall extrait ce bloc dans toolInfo.taskboard), donc
        // aucune reconstruction manuelle depuis les arguments plan/start/
        // complete n'est nécessaire côté serveur : on relaie tel quel et on
        // persiste dans activeTerminals pour une éventuelle reconnexion SSE.
        if (toolInfo.isTaskUpdate && toolInfo.taskboard) {
          const t2 = activeTerminals.get(sessionId);
          if (t2) t2.taskboard = toolInfo.taskboard;
          sseSend(res, 'taskboard', toolInfo.taskboard);
        }
      },
      onDone:    ()         => { clearTimeout(timeoutHandle); finish(); },
      onError:   (err)      => { clearTimeout(timeoutHandle); finish(`ECA events: ${err.message}`); },
      // Visualisation des sous-agents parallèles (Engine/TODO.org [#J]
      // Axe 5, étape 2) — relaie le détail capté par eca-client.js
      // (grep/read_file/etc. exécutés À L'INTÉRIEUR d'un spawn_agent en
      // cours) via un événement SSE dédié, distinct du flux 'tool'
      // principal. Maintient aussi un état par session (subagents) pour
      // permettre au frontend de reconstituer l'historique complet d'un
      // sous-agent même après une reconnexion SSE, et pour une éventuelle
      // étape 3 (regroupement DOM) qui a besoin de connaître l'ensemble
      // des sous-agents déjà vus, pas seulement le dernier événement.
      onSubagentToolLog: (subagentChatId, toolInfo) => {
        if (finished) return;
        const t = activeTerminals.get(sessionId);
        if (t) {
          t.subagents = t.subagents || {};
          t.subagents[subagentChatId] = t.subagents[subagentChatId] || [];
          t.subagents[subagentChatId].push(toolInfo);
        }
        sseSend(res, 'subagent-tool', { subagentChatId, toolInfo });
      },
    });
    subReq = sReq;
    activeTerminals.set(sessionId, {
      finish, chatId, sbId, level, entityId, projId, reportFile,
      startedAt:    Date.now(),
      lastMessage:  message.length > 160 ? message.slice(0, 160) + '…' : message,
      currentSkill: null,
      skillHistory: [],
      taskboard:    null,
      subagents:    {},
    });

    // ── Send the prompt ────────────────────────────────────────────────
    // Routage explicite skill → agent (Engine/TODO.org [#J] Axe 1) — via
    // eca.setChatAgent() (route REST POST /api/v1/chats/:id/agent,
    // confirmée empiriquement comme le seul mécanisme qui change
    // réellement l'agent d'un chat — le paramètre `agent` du body
    // /prompt lui-même n'a aucun effet observé, voir eca-client.js
    // § setChatAgent pour le détail de cette découverte). Best-effort :
    // un échec ne bloque jamais l'envoi du prompt.
    //
    // ⚠️ Cas nouveau chat (chatAlreadyExists === false) : POST /agent
    // échoue tant que le chat n'existe pas encore côté serveur ECA (créé
    // uniquement par le premier POST /prompt) — confirmé empiriquement
    // (404/erreur sur un chatId jamais vu). Stratégie retenue : envoyer
    // le prompt SANS l'attendre (fire-and-forget), patienter un court
    // délai (le temps que le serveur matérialise l'enregistrement du
    // chat — confirmé fiable dès 50ms en test réel), PUIS appeler
    // setChatAgent, et seulement ensuite attendre la vraie fin du prompt
    // via `promptPromise`. Cas chat existant : setChatAgent AVANT le
    // prompt fonctionne directement (pas de race condition à gérer).
    const expectedAgent = detectExpectedAgent(message);
    let promptPromise;

    if (chatAlreadyExists) {
      if (expectedAgent) await eca.setChatAgent(chatId, expectedAgent);
      promptPromise = eca.ecaRequest(
        `/api/v1/chats/${encodeURIComponent(chatId)}/prompt`, 'POST', { message: fullMessage }
      );
    } else {
      promptPromise = eca.ecaRequest(
        `/api/v1/chats/${encodeURIComponent(chatId)}/prompt`, 'POST', { message: fullMessage }
      );
      if (expectedAgent) {
        await new Promise((r) => setTimeout(r, 200)); // marge de sécurité vs. 50ms testé
        await eca.setChatAgent(chatId, expectedAgent);
      }
    }

    try {
      await promptPromise;
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
