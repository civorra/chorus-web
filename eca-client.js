/**
 * eca-client.js — Client pour le serveur ECA headless (mode remote)
 *
 * Protocole :
 *   - Auth : header "Authorization: Bearer <ECA_REMOTE_PASSWORD>"
 *   - POST /api/v1/chats/:id/prompt { message }  → crée/reprend le chat,
 *     renvoie immédiatement { status: "prompting" }
 *   - GET  /api/v1/events                        → SSE global (tous les chats)
 *     Événements : chat:opened · chat:content-received · chat:status-changed
 *     → subscribeEcaEvents() filtre par chatId et streame les réponses.
 *   - GET  /api/v1/chats/:id                     → état complet (Jetty 12 bug :
 *     socket hang up quand le chat contient du contenu — fallback via list)
 *   - Certificat TLS auto-signé (*.local.eca.dev) → rejectUnauthorized: false
 *
 * Deux modes de réception de réponse :
 *   SSE  (subscribeEcaEvents) — streaming temps réel, ask_user, pas de timeout
 *   Poll (promptAndWait)      — legacy, utilisé par /check et /chat
 */

'use strict';

const https = require('https');
const net   = require('net');
const { URL } = require('url');

const ECA_SERVER_URL      = process.env.ECA_SERVER_URL || 'https://eca-server:7777';
const ECA_REMOTE_PASSWORD = process.env.ECA_REMOTE_PASSWORD || '';

/**
 * Sonde la disponibilité d'eca-server par simple connexion TCP (handshake
 * de socket uniquement, aucune requête HTTP applicative) — utilisée par
 * GET /api/eca/health. Évite délibérément tout appel à ecaRequest() :
 * TOUTE route HTTP d'eca-server (vérifié empiriquement : /api/v1/chats,
 * /api/v1/events, /api/v1/chats/:id/prompt, /api/v1/chats/:id/agent) peut
 * déclencher un bug Jetty 12/GraalVM natif (IllegalArgumentException: "No
 * matching field found: getOutputStream for class
 * org.eclipse.jetty.ee9.nested.Response", cf. ring.adapter.jetty) — sans
 * impact fonctionnel observé (le client reçoit quand même sa réponse), mais
 * pollue bruyamment les logs serveur. Un health-check appelé en polling
 * (toutes les 30s par chorus-web.js § refreshEcaStatus) était la source
 * majoritaire de ce bruit (~46/54 occurrences sur un échantillon de 10 min)
 * — remplacé par une sonde TCP pure qui ne traverse jamais la couche HTTP
 * applicative d'eca-server, donc jamais ce bug, tout en restant un ping
 * de disponibilité équivalent (TLS handshake non inclus — latence mesurée
 * est donc légèrement optimiste par rapport à un vrai aller-retour HTTPS,
 * mais la connectivité TCP est la seule chose qu'un health-check doit
 * réellement vérifier ici).
 */
function pingTcp(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const target = new URL(ECA_SERVER_URL);
    const start = Date.now();
    const sock = net.createConnection({ host: target.hostname, port: target.port || 7777 });
    const onError = (e) => { sock.destroy(); reject(e); };
    sock.setTimeout(timeoutMs, () => onError(new Error('eca-server TCP ping timeout')));
    sock.on('error', onError);
    sock.on('connect', () => {
      const latencyMs = Date.now() - start;
      sock.end();
      resolve(latencyMs);
    });
  });
}

function ecaRequest(path, method, bodyObj) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, ECA_SERVER_URL);
    const body = bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined;
    const headers = { Authorization: `Bearer ${ECA_REMOTE_PASSWORD}` };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(
      { hostname: target.hostname, port: target.port, path: target.pathname, method, headers,
        rejectUnauthorized: false, timeout: 15000,
        // Disable connection reuse: the Jetty 12 bug causes socket hang-ups on
        // GET /chats/:id that leave the globalAgent's pooled sockets broken.
        // A fresh connection per request avoids reusing a destroyed socket.
        // Trade-off: one TLS handshake per request (~150ms overhead each).
        agent: false,
        // Reduce per-request timeout for polls (not for prompt POST).
        timeout: method === 'GET' ? 8000 : 15000 },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { /* laisser null */ }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`eca-server ${method} ${path} → HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          }
        });
      }
    );
    req.on('error', (e) => reject(new Error(`eca-server ${method} ${path} → ${e.message}`)));
    req.on('timeout', () => { req.destroy(new Error(`eca-server ${method} ${path} → timeout`)); });
    if (body) req.write(body);
    req.end();
  });
}

/** Extrait le texte du dernier message assistant d'un objet chat ECA. */
function lastAssistantText(chat) {
  const msgs = (chat && chat.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      return (msgs[i].content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
    }
  }
  return '';
}

/**
 * Envoie un prompt à un chat ECA (créé s'il n'existe pas) et attend la fin
 * du traitement par polling. `onTick` (optionnel) est appelé à chaque poll
 * avec le chat courant, utile pour journaliser la progression côté SSE.
 */
async function promptAndWait(chatId, message, { pollIntervalMs = 300, timeoutMs = 120000, onTick } = {}) {
  await ecaRequest(`/api/v1/chats/${encodeURIComponent(chatId)}/prompt`, 'POST', { message });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    // Primary: GET /api/v1/chats/:id — returns full chat with messages.
    // Known limitation: a Jetty 12 / Ring adapter bug causes socket hang up
    // when the chat contains large content (>~5 KB stored messages). In that
    // case we fall back to the list endpoint which is unaffected.
    let chat = null;
    try {
      chat = await ecaRequest(`/api/v1/chats/${encodeURIComponent(chatId)}`, 'GET');
    } catch (e) {
      if (!e.message.includes('socket hang up') && !e.message.includes('ECONNRESET')) {
        throw e; // Unknown error — propagate immediately.
      }
      // Jetty bug fallback: use GET /api/v1/chats (list) to check status only.
      try {
        const list = await ecaRequest('/api/v1/chats', 'GET');
        const entry = Array.isArray(list) ? list.find((c) => c.id === chatId) : null;
        if (!entry || entry.status === 'running') continue; // still processing
        // ECA is done but messages are unreadable via :id (Jetty bug).
        // Return a minimal shell so the caller gets a non-null idle object.
        chat = { id: chatId, status: entry.status, messages: [], pendingToolCalls: [],
                 _jettyFallback: true };
      } catch { continue; /* list call also failed — retry next tick */ }
    }

    if (onTick) onTick(chat);
    if (chat && chat.status !== 'running') {
      return chat;
    }
  }
  throw new Error(`eca-server: timeout en attente de réponse pour le chat ${chatId}`);
}

/**
 * Alternative à promptAndWait() basée sur SSE (subscribeEcaEvents) plutôt
 * que sur le polling GET /api/v1/chats/:id — contourne entièrement le bug
 * Jetty 12 documenté plus haut (socket hang up / "No matching field found:
 * getOutputStream") en n'appelant jamais cet endpoint : /api/v1/events
 * (utilisé par le terminal principal, server/routes/terminal.js) n'est pas
 * affecté. Préférer cette fonction à promptAndWait() pour tout nouvel appel
 * one-shot (un prompt → une réponse complète, pas de session interactive
 * multi-tour) — mêmes garanties (texte complet accumulé, pas de limite de
 * taille contrairement au fallback liste de promptAndWait qui renvoie un
 * texte vide en cas de bug Jetty).
 *
 * Subscribe AVANT d'envoyer le prompt (même pattern que
 * server/routes/terminal.js) pour éviter de manquer les tout premiers
 * événements si la réponse ECA commence avant que l'abonnement SSE soit
 * établi côté client.
 *
 * @returns {Promise<{status: string, text: string}>} status: 'idle' | 'error'
 */
async function promptAndWaitSSE(chatId, message, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let text = '';
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch {}
      reject(new Error(`eca-server: timeout en attente de réponse pour le chat ${chatId}`));
    }, timeoutMs);

    const { req } = subscribeEcaEvents(chatId, {
      onChunk: (t) => { text += t; },
      onDone: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve({ status: 'idle', text });
      },
      onError: (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        reject(new Error(`eca-server SSE ${chatId} → ${e.message}`));
      },
    });

    ecaRequest(`/api/v1/chats/${encodeURIComponent(chatId)}/prompt`, 'POST', { message })
      .catch((e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        try { req.destroy(); } catch {}
        reject(e);
      });
  });
}

// ── Tool call classification ────────────────────────────────────────────
// Regroupe les ~15 outils ECA en familles affichables (icône + couleur côté
// frontend) plutôt que de relayer un résumé texte opaque.
// ⚠️ Noms NUS, sans préfixe "eca__" : confirmé empiriquement en conditions
// réelles (session ECA 2026-10-13) sur tous les outils testés (read_file,
// grep, directory_tree, shell_command, skill, spawn_agent, task) — le
// préfixe "eca__" n'existe que côté outils MCP de LA SESSION COURANTE
// (celle-ci), jamais dans le payload que renvoie un eca-server distant
// piloté via son API HTTP+SSE. La version précédente de cette table
// (clés préfixées "eca__") ne matchait donc JAMAIS → tout tool-call
// tombait silencieusement dans DEFAULT_FAMILY (icône ⚙, label "Outil"),
// sans erreur ni log — bug corrigé ici, voir Engine/TODO.org [#J] Axe 3.
const TOOL_FAMILIES = {
  read_file:          { family: 'read',  icon: '📖', label: 'Lecture' },
  grep:               { family: 'read',  icon: '🔎', label: 'Recherche' },
  directory_tree:     { family: 'read',  icon: '🌳', label: 'Arborescence' },
  editor_diagnostics: { family: 'read',  icon: '🩺', label: 'Diagnostics' },
  edit_file:          { family: 'edit',  icon: '✏️', label: 'Édition' },
  write_file:         { family: 'edit',  icon: '📝', label: 'Écriture' },
  move_file:          { family: 'edit',  icon: '📦', label: 'Déplacement' },
  shell_command:      { family: 'shell', icon: '💻', label: 'Commande shell' },
  git:                { family: 'git',   icon: '🌿', label: 'Git' },
  spawn_agent:        { family: 'agent', icon: '🤖', label: 'Sous-agent' },
  task:               { family: 'task',  icon: '🗂️', label: 'Tâche' },
  skill:              { family: 'skill', icon: '📘', label: 'Skill' },
};
const DEFAULT_FAMILY = { family: 'other', icon: '⚙', label: 'Outil' };

/** Extrait un libellé court et pertinent depuis les arguments d'un tool call. */
function toolArgHint(name, args) {
  if (!args) return '';
  if (args.path) return args.path;
  if (args.source && args.destination) return `${args.source} → ${args.destination}`;
  if (args.command) return args.command.length > 80 ? args.command.slice(0, 80) + '…' : args.command;
  if (args.pattern) return args.pattern;
  if (args.agent) return `${args.agent}${args.activity ? ' — ' + args.activity : ''}`;
  if (args.op) return args.op;
  return '';
}

/**
 * Construit un objet structuré { family, icon, label, name, hint, detail,
 * isSubagent, agentName, subagentChatId, agentModel, agentStep,
 * isSkillLoad, skillName, isTaskUpdate, taskboard } à partir d'un
 * événement toolCalled/toolCallRun.
 *
 * Cas particulier "spawn_agent" : le serveur ECA fournit un bloc
 * `content.details` dédié quand il s'agit d'un sous-agent, confirmé en
 * conditions réelles :
 *   details: { type: 'subagent', subagentChatId, agentName, model, step, maxSteps }
 * On l'exploite pour permettre au frontend de distinguer visuellement
 * (indentation, couleur, libellé "agent: explorer") un appel de sous-agent
 * d'un tool-call standard — voir lvlTermAppendTool() dans chorus-web.html.
 *
 * Cas particulier "skill" : content.arguments.name porte le nom du skill
 * chargé (ex. "chorus-feed"), confirmé en conditions réelles sur l'event
 * toolCalled — voir server/routes/terminal.js § currentSkill pour l'usage
 * (bandeau "Skill actif" persistant, Engine/TODO.org [#J] Axe 3).
 *
 * Cas particulier "task" : content.details fournit DÉJÀ l'état consolidé
 * complet de la todo-list à chaque appel (plan/start/complete/…) — pas
 * besoin de reconstituer l'état côté client à partir des arguments bruts.
 * Confirmé en conditions réelles :
 *   details: { type: 'task', inProgressTaskIds: [...], tasks: [{ id,
 *     subject, description, status, priority, isBlocked }, ...],
 *     summary: { done, inProgress, pending, total }, activeSummary? }
 * Voir server/routes/terminal.js § taskboard pour l'usage (panneau de
 * tâches temps réel, Engine/TODO.org [#J] Axe 4).
 */
function classifyToolCall(content) {
  const meta = TOOL_FAMILIES[content.name] || DEFAULT_FAMILY;
  const hint = toolArgHint(content.name, content.arguments);
  const outputText = Array.isArray(content.outputs)
    ? content.outputs.filter((o) => o.type === 'text').map((o) => o.text).join('\n')
    : '';
  const isSubagent = content.details?.type === 'subagent';
  const isSkillLoad = content.name === 'skill';
  const isTaskUpdate = content.name === 'task' && content.details?.type === 'task';
  return {
    family: meta.family,
    icon:   meta.icon,
    label:  meta.label,
    name:   content.name,
    hint,
    summary: content.summary || `${meta.label}${hint ? ' — ' + hint : ''}`,
    detail: outputText.slice(0, 4000),
    isSubagent,
    agentName:      isSubagent ? content.details.agentName : null,
    subagentChatId: isSubagent ? content.details.subagentChatId : null,
    agentModel:     isSubagent ? content.details.model : null,
    agentStep:      isSubagent ? content.details.step : null,
    agentMaxSteps:  isSubagent ? content.details.maxSteps : null,
    isSkillLoad,
    skillName: isSkillLoad ? (content.arguments?.name || null) : null,
    // path — cible principale de l'outil (eca__write_file, eca__edit_file,
    // eca__read_file, eca__move_file, eca__directory_tree, etc.)
    // Utilisé par terminal.js § WEB-021 pour détecter les écritures sur
    // les fichiers de résultats clés et déclencher un refresh SSE.
    path: content.arguments?.path || content.arguments?.destination || null,
    isTaskUpdate,
    taskboard: isTaskUpdate ? {
      tasks:             content.details.tasks || [],
      summary:           content.details.summary || null,
      inProgressTaskIds: content.details.inProgressTaskIds || [],
      activeSummary:     content.details.activeSummary || null,
      op:                content.arguments?.op || null,
    } : null,
  };
}

/**
 * Connects to ECA's global SSE event stream (GET /api/v1/events), filters
 * events for a specific chatId AND any sub-agent chat spawned from it, and
 * dispatches them to handlers.
 *
 * ⚠️ Sub-agent visibility (Engine/TODO.org [#J] Axe 5): ECA emits a
 * sub-agent's OWN tool calls (its internal grep/read_file/etc., executed
 * while `spawn_agent` is running) under a SEPARATE chatId, formatted
 * `subagent-<spawnAgentToolCallId>` — confirmed empirically (session ECA
 * 2026-10-13) by inspecting the raw SSE stream without chatId filtering.
 * These events are invisible to any caller that only watches the parent
 * chatId (which was the case before this function tracked sub-chats) —
 * only the `spawn_agent` start/end markers (toolCallRun/toolCallRunning/
 * toolCalled on the PARENT chatId, carrying `details.subagentChatId`) were
 * visible, making every sub-agent an opaque black box between launch and
 * completion. This function now watches the parent chatId AND dynamically
 * adds each `subagentChatId` to its watch set as soon as a `spawn_agent`
 * toolCallRun reveals it — the underlying SSE connection is global
 * (`/api/v1/events` already streams every chat), so widening the filter
 * is enough; no additional HTTP request or connection is needed.
 *
 * Returns { req, done } where:
 *   req  — the underlying https.Request; call req.destroy() to cancel
 *   done — Promise that resolves when the PARENT chat reaches 'idle'
 *          (sub-agent idle events do not resolve this promise — the
 *          parent's own 'idle' already implies all its sub-agents have
 *          completed, since spawn_agent is a synchronous tool call from
 *          the parent's perspective)
 *
 * handlers:
 *   onChunk(text)                      — assistant text fragment (parent chat only)
 *   onAsk({ question, toolId })        — ECA issued an ask_user tool call (parent only)
 *   onToolLog(toolInfo)                — structured tool call info, PARENT chat only —
 *                                         see classifyToolCall() for the shape
 *   onSubagentToolLog(subagentChatId, toolInfo) — same shape as onToolLog, but for
 *                                         a tool call executed INSIDE a running
 *                                         sub-agent (Axe 5) — optional, omit to keep
 *                                         previous behaviour (sub-agent detail ignored)
 *   onDone()                           — parent chat reached 'idle' status
 *   onError(err)                       — network or parse error
 */
function subscribeEcaEvents(chatId, { onChunk, onAsk, onToolLog, onSubagentToolLog, onDone, onError } = {}) {
  const base = new URL(ECA_SERVER_URL);
  let resolvePromise, rejectPromise;
  const done = new Promise((res, rej) => { resolvePromise = res; rejectPromise = rej; });

  // Watch set: starts with just the parent chatId, grows as spawn_agent
  // calls reveal sub-agent chatIds. A plain Set is enough — the SSE
  // connection itself is global, this only widens which chatId values
  // we react to (see Axe 5 doc comment above).
  const watchedChatIds = new Set([chatId]);

  const req = https.request(
    {
      hostname: base.hostname, port: base.port || 7777,
      path: '/api/v1/events', method: 'GET',
      headers: { Authorization: `Bearer ${ECA_REMOTE_PASSWORD}` },
      rejectUnauthorized: false, agent: false,
      // No timeout — keep-alive until ECA finishes or caller destroys
    },
    (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        const blocks = buf.split('\n\n');
        buf = blocks.pop(); // keep incomplete last block
        for (const block of blocks) {
          if (!block.trim()) continue;
          const evtMatch = block.match(/^event:\s*(.+)/m);
          const datMatch = block.match(/^data:\s*(.+)/m);
          if (!evtMatch || !datMatch) continue;
          const eventType = evtMatch[1].trim();
          let data;
          try { data = JSON.parse(datMatch[1]); } catch { continue; }

          const isParentChat = data.chatId === chatId;
          const isSubagentChat = !isParentChat && watchedChatIds.has(data.chatId);
          if (!isParentChat && !isSubagentChat) continue; // unrelated chat — ignore

          if (eventType === 'chat:content-received') {
            const { role, content } = data;
            if (!content) continue;

            // Sub-agent chat: only relay its own tool calls (if a handler is
            // provided) — ignore text chunks / ask_user for sub-chats, the
            // parent's spawn_agent call already owns the user-facing flow.
            if (isSubagentChat) {
              if (role === 'assistant' && content.type === 'toolCalled' && onSubagentToolLog) {
                onSubagentToolLog(data.chatId, classifyToolCall(content));
              }
              continue;
            }

            // Parent chat — original behaviour, unchanged.
            if (role === 'assistant') {
              // Streaming text fragment
              if (content.type === 'text' && content.text) {
                if (onChunk) onChunk(content.text);
              }
              // Tool call pending manual approval — relay to the UI
              // (event type 'toolCallRun' with manualApproval:true)
              if (content.type === 'toolCallRun' && content.manualApproval) {
                const cmd = content.arguments?.command
                  || content.summary
                  || `${content.name}(${JSON.stringify(content.arguments || {}).slice(0, 60)})`;
                if (onAsk) onAsk({ question: `Approuver : ${cmd}`, toolId: content.id, isApproval: true });
              }
              // Sub-agent launch detected — start watching its chatId so
              // its own tool calls (received under that separate chatId,
              // see Axe 5 doc comment above) are no longer silently dropped.
              if (content.type === 'toolCallRun' && content.details?.type === 'subagent'
                  && content.details.subagentChatId) {
                watchedChatIds.add(content.details.subagentChatId);
              }
              // Tool call completed (after approval or auto-trust)
              if (content.type === 'toolCalled') {
                if (content.name === 'ask_user') {
                  const question = content.arguments?.question
                    || content.outputs?.[0]?.text || '(question ECA)';
                  if (onAsk) onAsk({ question, toolId: content.id, isApproval: false });
                } else if (onToolLog) {
                  onToolLog(classifyToolCall(content));
                }
              }
            }
          }

          // Only the PARENT reaching 'idle' ends this subscription — a
          // sub-agent's own 'idle' is expected (it finishes before/with the
          // parent's spawn_agent toolCalled) and must not resolve `done` early.
          if (isParentChat && eventType === 'chat:status-changed' && data.status === 'idle') {
            if (onDone) onDone();
            resolvePromise();
          }
        }
      });
      res.on('end', () => resolvePromise());
      res.on('error', (e) => { if (onError) onError(e); rejectPromise(e); });
    }
  );
  req.on('error', (e) => { if (onError) onError(e); rejectPromise(e); });
  req.end();

  return { req, done };
}

/**
 * Pilote le flow conversationnel natif `/login <provider>` d'ECA (Engine
 * AGENTS.md § investigation 2026-10-17 — auth.js § ECA LOGIN NATIF).
 *
 * Contrairement à `subscribeEcaEvents` (conçu pour un prompt normal :
 * texte assistant + tool calls + idle final), ce flow est un dialogue
 * système multi-tour piloté par `chat:ask-question` (ECA attend une
 * réponse texte exacte, ex. "github-copilot", "max") et se termine par un
 * `chat:content-received` texte contenant soit un couple
 * (user_code, verification_uri) pour un provider device-flow (ex.
 * github-copilot), soit une URL + instruction de coller un code retour
 * pour un provider authorization-code manuel (ex. anthropic "max").
 *
 * ⚠️ CRITIQUE (confirmé empiriquement 2026-10-17, 2 échecs avant succès) :
 * la connexion SSE `/api/v1/events` DOIT rester ouverte pendant toute la
 * durée de l'attente de validation humaine côté provider (ex. tant que
 * l'utilisateur n'a pas validé le code sur github.com/login/device) — le
 * polling interne d'ECA vers le provider semble lié au cycle de vie de
 * cette connexion HTTP. La fermer prématurément (même après avoir reçu le
 * code) fait que le chat reste bloqué en status "login" indéfiniment, sans
 * jamais recevoir la confirmation "Login successful!".
 *
 * Usage (provider device-flow, ex. github-copilot) :
 *   1. sendLoginStep(chatId, '/login github')
 *   2. onQuestion → répondre avec le label exact demandé (ex. 'github-copilot')
 *   3. onCodeReady({ url, code }) → afficher à l'utilisateur
 *   4. (attente — NE PAS fermer le stream) onSuccess() quand la validation
 *      humaine aboutit côté provider
 *
 * Usage (provider authorization-code manuel, ex. anthropic max) :
 *   1. sendLoginStep(chatId, '/login') puis répondre 'anthropic' puis 'max'
 *   2. onUrlReady({ url }) → l'utilisateur ouvre l'URL, s'authentifie,
 *      récupère un code affiché par le provider
 *   3. sendLoginStep(chatId, '<code collé par l'utilisateur>')
 *   4. onSuccess()
 *
 * @param {string} chatId — identifiant de chat dédié à cette session de login
 * @param {object} handlers
 *   onQuestion({ question, options, requestId }) — ECA attend une réponse
 *   onCodeReady({ url, code })  — device-flow : code + URL à afficher
 *   onUrlReady({ url })         — authorization-code : URL à ouvrir
 *   onSuccess()                 — "Login successful!" détecté
 *   onCancelled()                — login annulé/expiré côté ECA
 *   onError(err)
 * @returns {{ req: object, destroy: function }} — req = requête HTTPS SSE
 *   sous-jacente ; appeler destroy() seulement après onSuccess/onError/
 *   onCancelled (jamais avant, voir avertissement ci-dessus).
 */
function subscribeLoginFlow(chatId, initialHandlers = {}) {
  const base = new URL(ECA_SERVER_URL);
  let destroyed = false;
  // Handlers mutables : /start fournit onQuestion/onCodeReady/onUrlReady,
  // puis /wait (route HTTP séparée, appelée plus tard par le frontend)
  // complète avec onSuccess/onCancelled/onError via setHandlers() —
  // nécessaire car la connexion SSE est ouverte une seule fois dans /start
  // (voir avertissement critique ci-dessus) mais ses callbacks de
  // complétion ne sont connus/utiles qu'au moment de /wait.
  const h = { ...initialHandlers };

  const req = https.request(
    {
      hostname: base.hostname, port: base.port || 7777,
      path: '/api/v1/events', method: 'GET',
      headers: { Authorization: `Bearer ${ECA_REMOTE_PASSWORD}` },
      rejectUnauthorized: false, agent: false,
    },
    (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        const blocks = buf.split('\n\n');
        buf = blocks.pop();
        for (const block of blocks) {
          if (!block.trim()) continue;
          const evtMatch = block.match(/^event:\s*(.+)/m);
          const datMatch = block.match(/^data:\s*(.+)/m);
          if (!evtMatch || !datMatch) continue;
          const eventType = evtMatch[1].trim();
          let data;
          try { data = JSON.parse(datMatch[1]); } catch { continue; }

          if (data.chatId !== chatId) continue; // unrelated chat — ignore

          if (eventType === 'chat:ask-question') {
            if (h.onQuestion) h.onQuestion({ question: data.question, options: data.options || [], requestId: data.requestId });
          }

          if (eventType === 'chat:content-received' && data.role === 'system' && data.content?.type === 'text') {
            const text = data.content.text || '';

            // Device-flow (github-copilot) : "...code:\n\n`XXXX-XXXX`"
            // + "...open your browser at [url](url)..."
            const codeMatch = text.match(/code:\s*\n*\s*`([A-Z0-9-]+)`/);
            const deviceUrlMatch = text.match(/open your browser at \[(https?:\/\/[^\]]+)\]/);
            if (codeMatch && deviceUrlMatch && h.onCodeReady) {
              h.onCodeReady({ url: deviceUrlMatch[1], code: codeMatch[1] });
            }

            // Authorization-code manuel (anthropic max) : "Open your browser
            // at: [Anthropic login](<url>)" sans code immédiat — l'user doit
            // coller un code retour ensuite.
            const authUrlMatch = text.match(/Open your browser at:\s*\[[^\]]+\]\((https?:\/\/[^)]+)\)/);
            if (authUrlMatch && !codeMatch && h.onUrlReady) {
              h.onUrlReady({ url: authUrlMatch[1] });
            }

            // Succès — texte exact confirmé empiriquement : "Login successful!"
            if (/Login successful!/i.test(text) && h.onSuccess) {
              h.onSuccess();
            }

            // Annulation / expiration
            if (/cancelled|canceled|expired|délai d'autorisation expiré/i.test(text) && h.onCancelled) {
              h.onCancelled();
            }
          }
        }
      });
      res.on('end', () => { if (!destroyed && h.onError) h.onError(new Error('eca-server: connexion SSE login fermée')); });
      res.on('error', (e) => { if (!destroyed && h.onError) h.onError(e); });
    }
  );
  req.on('error', (e) => { if (!destroyed && h.onError) h.onError(e); });
  req.end();

  return {
    req,
    destroy: () => { destroyed = true; try { req.destroy(); } catch {} },
    // Fusionne de nouveaux handlers (ex. onSuccess/onCancelled/onError
    // attachés plus tard par la route /wait) sans perdre ceux déjà en place.
    setHandlers: (more) => { Object.assign(h, more); },
  };
}

/**
 * Envoie un message dans un chat de login en cours (répond à une
 * ask-question, ou lance la commande initiale `/login <provider>`).
 * Simple alias sémantique de ecaRequest pour la lisibilité côté auth.js.
 */
function sendLoginStep(chatId, message) {
  return ecaRequest(`/api/v1/chats/${encodeURIComponent(chatId)}/prompt`, 'POST', { message });
}

/**
 * Force l'agent ECA (architect/code/fast/…) d'un chat existant
 * (Engine/TODO.org [#J] Axe 1 — routage explicite skill → agent).
 *
 * ⚠️ Découverte empirique (session ECA 2026-10-13) : le champ `agent` du
 * body de `POST /api/v1/chats/:id/prompt` (documenté côté protocole
 * JSON-RPC `chat/prompt` sur https://eca.dev/protocol/) N'A AUCUN EFFET
 * observé sur l'API REST `/api/v1/chats/:id/prompt` — testé et confirmé :
 * un chat créé avec `{ message, agent: 'architect' }` reste sur
 * `defaultAgent` (`GET /api/v1/chats/:id` → `agent: "code"`).
 *
 * Le mécanisme qui fonctionne réellement est une route REST séparée, non
 * documentée dans https://eca.dev/protocol/ (qui ne documente que le
 * JSON-RPC stdin, pas le mapping HTTP du mode `remote`) mais découverte
 * et confirmée empiriquement : `POST /api/v1/chats/:id/agent` avec
 * `{ agent }` → `204 No Content`, et l'agent du chat change durablement
 * (vérifié via `GET /api/v1/chats/:id` → `agent` mis à jour). Cette route
 * correspond très probablement à l'implémentation serveur de la
 * notification JSON-RPC `chat/selectedAgentChanged` documentée dans le
 * protocole, simplement exposée différemment côté API HTTP remote.
 *
 * Appeler cette fonction AVANT d'envoyer le prompt (`ecaRequest(.../prompt)`)
 * sur un chat dont l'agent attendu est connu à l'avance (cf.
 * server/routes/terminal.js § AGENT_BY_TRIGGER) — ne bloque jamais l'envoi
 * du prompt en cas d'échec (best-effort, voir `onError`).
 *
 * @param {string} chatId
 * @param {string} agentName — ex. 'architect', 'code', 'fast'
 * @returns {Promise<boolean>} true si la requête a abouti (204), false sinon
 */
async function setChatAgent(chatId, agentName) {
  try {
    await ecaRequest(`/api/v1/chats/${encodeURIComponent(chatId)}/agent`, 'POST', { agent: agentName });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { ecaRequest, pingTcp, promptAndWait, promptAndWaitSSE, lastAssistantText, subscribeEcaEvents, setChatAgent, subscribeLoginFlow, sendLoginStep };
