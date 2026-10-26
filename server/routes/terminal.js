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
    kind:        t.kind || null,
    startedAt:   t.startedAt || null,
    elapsedMs:   t.startedAt ? Date.now() - t.startedAt : null,
    lastMessage: t.lastMessage || null,
  }));
  res.json({ ok: true, count: sessions.length, sessions });
});

// ── POST /api/sandboxes/:sbId/terminal ───────────────────────────────────
router.post('/sandboxes/:sbId/terminal', (req, res) => {
  const { sbId } = req.params;
  const { level, entityId, projId, reportFile, sessionId, message, timeoutMinutes, kind } = req.body;

  if (!message || !sessionId) { sseInit(res); return sseError(res, 'message/sessionId manquant'); }
  if (!['sandbox', 'entity', 'project', 'report'].includes(level)) {
    sseInit(res); return sseError(res, `level invalide : ${level}`);
  }

  // ── Garde de concurrence — chorus-strengthen / chorus-stress ─────────
  // Ces commandes peuvent être très chronophages, produire des boucles
  // infinies côté Perl et faire grimper le CPU à 99% (cf. Engine/AGENTS.md
  // et retour utilisateur) — on interdit catégoriquement plus d'une session
  // de ce type active simultanément sur un même sandbox, avant même de
  // contacter eca-server. `kind` est fourni explicitement par le bouton
  // dédié de l'onglet TESTS (jamais déduit du texte libre — un utilisateur
  // tapant "lance chorus-strengthen" dans un terminal normal n'est pas
  // bloqué ici, seule la UI "Renforcer" de l'onglet TESTS positionne ce flag).
  if (kind === 'strengthen') {
    const already = [...activeTerminals.values()]
      .find(t => t.sbId === sbId && t.kind === 'strengthen');
    if (already) {
      sseInit(res);
      return sseError(
        res,
        `Un chorus-strengthen est déjà en cours sur ce sandbox depuis ` +
        `${Math.round((Date.now() - (already.startedAt || Date.now())) / 60000)} min — ` +
        `attendez sa fin avant d'en relancer un (risque CPU élevé en cas d'exécution concurrente).`
      );
    }
  }

  // ── Garde de concurrence — chorus-fix ──────────────────────────────
  // chorus-fix peut modifier des fichiers YAML et déclencher chorus-feed
  // --enrich (bucket-c) — interdit d'en avoir deux simultanément sur le même
  // sandbox (risque de conflits d'écriture et de rapports de gaps incohérents).
  if (kind === 'fix') {
    const already = [...activeTerminals.values()]
      .find(t => t.sbId === sbId && (t.kind === 'fix' || t.kind === 'strengthen'));
    if (already) {
      sseInit(res);
      return sseError(
        res,
        `Un ${already.kind === 'fix' ? 'chorus-fix' : 'chorus-strengthen'} est déjà en cours sur ce sandbox — ` +
        `attendez sa fin avant de lancer chorus-fix (risque de conflits sur les fichiers YAML).`
      );
    }
  }

  sseInit(res);
  // Timeout configurable (panneau Config § ECA Server, défaut 60 min côté
  // frontend — voir chorus-web.js § SETTINGS.eca.terminalTimeoutMinutes).
  // Borné ici indépendamment du frontend par sécurité (1 min .. 4h) en cas
  // de valeur corrompue/absente transmise par un client plus ancien.
  // Les sessions `kind: 'strengthen'` utilisent un plafond réduit (45 min
  // par défaut au lieu de 60) pour limiter l'exposition en cas de boucle
  // infinie côté pipeline Perl — toujours modifiable explicitement par le
  // frontend via timeoutMinutes, jamais silencieusement étendu au-delà.
  // chorus-fix (bucket-b seul) est rapide ; --bucket-c peut déclencher
  // chorus-feed --enrich qui est long → timeout intermédiaire 30 min.
  const DEFAULT_TIMEOUT_MINUTES = kind === 'strengthen' ? 45 : kind === 'fix' ? 30 : 60;
  let timeoutMs = Number(timeoutMinutes);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) timeoutMs = DEFAULT_TIMEOUT_MINUTES;
  if (timeoutMs > 240) timeoutMs = 240;
  timeoutMs = timeoutMs * 60_000;

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

      // ── Enrichissement spécialisé pour chorus-strengthen / chorus-fix ──
      // Injecte les données déjà lues par scanSandbox() (convergence, rapport
      // de gaps) pour éviter que l'agent ECA reparte de zéro. Ajouté en
      // complément du contextBlock de base (pas en remplacement).
      if (kind === 'strengthen' || kind === 'fix') {
        const sbPath  = sb.path;
        const lcr     = chorus.readLastCheckResults(sbPath);
        const lsr     = chorus.readLastStrengthenReport(sbPath);
        const testing = sb.testing || {};

        // ── Convergence summary (from .last-check-results.json) ──────────
        const STRATEGIES = ['iso', 'edges', 'cross', 'scale'];
        const convergenceLines = STRATEGIES
          .filter(s => testing[s])
          .map(s => {
            const entry = testing[s];
            const cv    = entry.convergence;
            if (!cv) return `  ${entry.file}: jamais exécuté en mode --all`;
            const disc = cv.discordances || 0;
            const unp  = cv.unprocessed  || 0;
            const st   = cv.stale ? ' [STALE]' : '';
            const ok   = disc === 0 && unp === 0 ? '✅' : '⚠️';
            return `  ${ok} ${entry.file}: ${disc} discordance(s), ${unp} unprocessed${st}`;
          });

        let extra = '';

        if (convergenceLines.length) {
          extra += `\n\nÉtat de convergence (source: .last-check-results.json):\n${convergenceLines.join('\n')}`;
          if (lcr?.stale) extra += `\n  ⚠️ Résultats périmés — KB modifiée depuis le dernier chorus-check --all.`;
        } else {
          extra += `\n\nAucun fichier project-*.json trouvé — lancez chorus-create-project --batch d'abord.`;
        }

        // ── Gap report summary (from .last-strengthen-report.json) ───────
        if (kind === 'fix') {
          if (!lsr) {
            extra += `\n\nRapport chorus-strengthen : absent — lancez chorus-strengthen ${sbId} avant chorus-fix.`;
          } else if (lsr.stale) {
            extra += `\n\nRapport chorus-strengthen : PÉRIMÉ (KB modifiée depuis). Relancez chorus-strengthen avant chorus-fix.`;
          } else {
            const { bucket_b = 0, bucket_c = 0, bucket_a = 0 } = lsr.summary || {};
            extra += `\n\nRapport chorus-strengthen (${lsr.timestamp?.slice(0, 16) || '?'}):\n`;
            extra += `  Total gaps : ${lsr.totalGaps}  (B:${bucket_b} C:${bucket_c} A:${bucket_a})\n`;
            if (lsr.gaps?.length) {
              extra += `  Gaps détaillés :\n`;
              for (const g of lsr.gaps) {
                const blocked = g.blocked ? ' [BLOQUÉ — garde anti-régression]' : '';
                extra += `  #${g.id} [${g.bucket}] ${g.gap_type} · ${g.element_id} · règle: ${g.rule_file || '—'} · agent: ${g.agent || '—'}${blocked}\n`;
                if (g.hypothesis) extra += `     Hypothèse: ${g.hypothesis}\n`;
                if (g.corpus_ref && g.corpus_ref !== 'null') extra += `     Réf corpus: ${g.corpus_ref}\n`;
              }
            }
          }
        } else {
          // strengthen : indiquer si un rapport existe déjà (évite une relance inutile)
          if (lsr && !lsr.stale && lsr.totalGaps > 0) {
            const { bucket_b = 0, bucket_c = 0, bucket_a = 0 } = lsr.summary || {};
            extra += `\n\nDernier rapport strengthen (${lsr.timestamp?.slice(0, 16) || '?'}): ${lsr.totalGaps} gap(s) (B:${bucket_b} C:${bucket_c} A:${bucket_a}) — toujours valide si la KB n'a pas changé.`;
          }
        }

        contextBlock += extra;
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
          `Engine AGENTS.md: ${path.join(chorusHome, 'engine', 'AGENTS.md')}. ` +
          `Read it via your tools when needed to answer Chorus commands.\n\n`;
      }
    } catch { /* proceed without prefix */ }

    // ── Directive skill — chargement explicite pour les commandes Chorus connues ──
    // ECA reçoit seulement le chemin de l'AGENTS.md, qu'il peut ne pas lire s'il
    // connaît la commande de son entraînement. Sans appel à eca__skill(), nos
    // améliorations (Phase 0-bis/2.0-bis/4-checkpoint, eca__task, eca__ask_user)
    // sont ignorées. Solution : injecter une directive explicite pour forcer le
    // chargement du skill depuis le disque (version à jour).
    const CHORUS_SKILL_MAP = {
      strengthen:       'chorus-strengthen',
      fix:              'chorus-fix',
      // les autres kinds n'ont pas de skill dédié ou sont gérés par le message lui-même
    };
    // Pour tout message contenant un déclencheur Chorus connu, forcer eca__skill
    const knownSkillPatterns = [
      { re: /\bchorus-strengthen\b/, skill: 'chorus-strengthen' },
      { re: /\bchorus-check\b/,      skill: 'chorus-check'      },
      { re: /\bchorus-feed\b/,       skill: 'chorus-feed'       },
      { re: /\bchorus-create-project\b/, skill: 'chorus-create-project' },
      { re: /\bchorus-fix\b/,        skill: 'chorus-fix'        },
      { re: /\bchorus-stress\b/,     skill: 'chorus-stress'     },
    ];
    const detectedSkill = (() => {
      if (CHORUS_SKILL_MAP[kind]) return CHORUS_SKILL_MAP[kind];
      for (const { re, skill } of knownSkillPatterns) {
        if (re.test(message)) return skill;
      }
      return null;
    })();

    // ── Directive skill — injection des instructions critiques ──────────
    // La simple invite à charger le skill est insuffisante : ECA peut l'ignorer
    // et exécuter la commande depuis son entraînement (comportement observé :
    // scan de tous les run-report-*.json au lieu de lire .last-check-results.json).
    // Solution : injecter les règles critiques directement dans le contexte.
    const SKILL_CRITICAL_RULES = {
      'chorus-strengthen': [
        '⛔ NE JAMAIS scanner les fichiers run-report-*.json individuels — ils contiennent des données brutes potentiellement obsolètes.',
        '✅ Phase 1.1 OBLIGATOIRE en premier : lire $SANDBOX/.last-check-results.json pour le cache (kb_hash + proj_hash).',
        '✅ Si cache HIT (les deux hashes correspondent) : utiliser ces résultats DIRECTEMENT, NE PAS relancer chorus-check.',
        '✅ Si cache MISS seulement : spawner des sous-agents via eca__spawn_agent pour chorus-check --all.',
        '✅ Phase 0-bis : appeler eca__task(op="plan",...) pour afficher le taskboard de progression.',
        '✅ Phase 2.0-bis : détecter les bugs C2-C5 dans les fichiers projet avant de classer comme gaps KB.',
        '✅ Phase 4-checkpoint : appeler eca__ask_user() pour valider les hypothèses avant Phase 4.5.',
      ],
      'chorus-check': [
        '✅ Mode --all : spawner un sous-agent par project-*.json via eca__spawn_agent.',
        '✅ Phase 6.3 (mono-projet) : mettre à jour .last-check-results.json après chaque run.',
        '✅ Phase 6-all.0-bis : appeler eca__task(op="plan",...) pour le taskboard.',
      ],
      'chorus-create-project': [
        '✅ Phase 6.2 step 5 : mettre à jour .last-check-results.json avec proj_hash path-indépendant.',
        '✅ proj_hash = sha256sum project-*.json | awk \'{print $1}\' | sha256sum (PAS sha256sum|sha256sum direct).',
      ],
      'chorus-feed': [
        '✅ § 0-bis : appeler eca__task(op="plan",...) pour le taskboard au démarrage.',
      ],
    };

    const skillDirective = detectedSkill
      ? (() => {
          const rules = SKILL_CRITICAL_RULES[detectedSkill] || [];
          const rulesBlock = rules.length
            ? '\nRègles critiques à respecter impérativement :\n' + rules.map(r => `  ${r}`).join('\n')
            : '';
          return `\n\n[SKILL OBLIGATOIRE — à exécuter EN PREMIER, avant tout autre outil]\n` +
            `Charge le skill via : eca__skill("${detectedSkill}")${rulesBlock}\n` +
            `⛔ NE commence JAMAIS à exécuter sans avoir d'abord chargé son skill — le skill contient les instructions à jour.`;
        })()
      : '';

    const DONE_INSTRUCTION =
      '\n\n[TERMINAL PROTOCOL — OBLIGATOIRE] ' +
      'Quand ta réponse est entièrement terminée — skill accompli, fichiers écrits, question répondue — ' +
      'tu dois écrire en toute dernière ligne, seule sur sa ligne, le mot exactement : DONE';

    const fullMessage =
      `${agentsPrefix}[Contexte ECA — niveau ${level}]\n${contextBlock}\n\nQuestion : ${message}` +
      skillDirective +
      DONE_INSTRUCTION;

    // ── Subscribe BEFORE sending ─────────────────────────────────────────
    let subReq = null, finished = false;
    // ── Guard eca__ask_user — WEB-025 ─────────────────────────────────────
    // When ECA calls eca__ask_user the chat status briefly goes 'idle' while
    // waiting for the user's answer, which would trigger onDone → finish()
    // and close the SSE stream before the user has responded.
    // Fix: set waitingForUserInput = true in onAsk, clear it in /respond,
    // and guard both onDone and the timeout against premature closure.
    let waitingForUserInput = false;
    let pendingTimeoutRestart = null; // stores remaining ms to restart timeout after respond

    const heartbeat = setInterval(() => {
      if (!finished) sseSend(res, 'ping', { t: Date.now() });
    }, 15000);

    const finish = (errMsg) => {
      if (finished) return;
      finished = true;
      activeTerminals.delete(sessionId);
      clearInterval(heartbeat);
      if (pendingTimeoutRestart) { clearTimeout(pendingTimeoutRestart); pendingTimeoutRestart = null; }
      if (subReq) { try { subReq.destroy(); } catch {} }
      if (errMsg) sseError(res, errMsg);
      else sseDone(res, {});
    };

    let timeoutHandle = setTimeout(
      () => {
        if (waitingForUserInput) {
          // User hasn't answered yet — extend by the full configured timeout
          // rather than closing the session mid-question.
          pendingTimeoutRestart = setTimeout(
            () => finish(`timeout après attente réponse utilisateur (${Math.round(timeoutMs / 60_000)} min supplémentaires)`),
            timeoutMs
          );
        } else {
          finish(`timeout après ${Math.round(timeoutMs / 60_000)} min — skill encore en cours côté ECA`);
        }
      },
      timeoutMs
    );

    const { req: sReq, done } = eca.subscribeEcaEvents(chatId, {
      onChunk:   (text)     => { if (!finished) sseSend(res, 'chunk', { text }); },
      onAsk:     (payload)  => {
        if (!finished) {
          waitingForUserInput = true;
          sseSend(res, 'ask', payload);
        }
      },
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
        // Refresh live de l'onglet Tests (WEB-021) — détecte les écritures
        // sur les fichiers clés de résultats (.last-check-results.json,
        // .last-strengthen-report.json) et envoie un événement SSE 'refresh'
        // pour que le frontend puisse mettre à jour les badges de convergence
        // AVANT que le terminal n'ait reçu son DONE final.
        // Heuristique : eca__write_file envoie le chemin cible dans toolInfo
        // (extrait par classifyToolCall depuis les arguments de l'outil).
        // On teste sur le basename uniquement pour rester robuste aux chemins
        // absolus variables selon la machine/sandbox.
        if (toolInfo.name === 'eca__write_file' && toolInfo.path) {
          const base = require('path').basename(toolInfo.path);
          const REFRESH_TRIGGERS = new Set([
            '.last-check-results.json',
            '.last-strengthen-report.json',
            '.last-fix-history.json',
          ]);
          if (REFRESH_TRIGGERS.has(base)) {
            sseSend(res, 'refresh', { sbId });
          }
        }
      },
      onDone:    ()         => {
        // Guard: if eca__ask_user is pending, the 'idle' event is transient
        // (ECA waiting for user input) — do NOT finish here. The session will
        // naturally complete after the user responds and ECA reaches idle again.
        if (waitingForUserInput) return;
        clearTimeout(timeoutHandle);
        finish();
      },
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
      kind:         kind || null,
      startedAt:    Date.now(),
      lastMessage:  message.length > 160 ? message.slice(0, 160) + '…' : message,
      currentSkill: null,
      skillHistory: [],
      taskboard:    null,
      subagents:    {},
      // WEB-025: exposed by /respond to clear the ask_user guard and reset timeout
      clearAskWait: () => {
        waitingForUserInput = false;
        // Restart the timeout from zero so the agent has the full configured
        // duration to complete its work after the user has answered.
        clearTimeout(timeoutHandle);
        if (pendingTimeoutRestart) { clearTimeout(pendingTimeoutRestart); pendingTimeoutRestart = null; }
        timeoutHandle = setTimeout(
          () => finish(`timeout après ${Math.round(timeoutMs / 60_000)} min — skill encore en cours côté ECA`),
          timeoutMs
        );
      },
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
  // WEB-025: clear the ask_user guard BEFORE injecting the response so that
  // the next 'idle' event (ECA resuming and completing normally) properly
  // triggers onDone → finish() instead of being swallowed by the guard.
  // Also resets the timeout so the agent has the full duration to finish.
  const t = activeTerminals.get(sessionId);
  if (t?.clearAskWait) t.clearAskWait();
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
