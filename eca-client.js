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
const { URL } = require('url');

const ECA_SERVER_URL      = process.env.ECA_SERVER_URL || 'https://eca-server:7777';
const ECA_REMOTE_PASSWORD = process.env.ECA_REMOTE_PASSWORD || '';

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
 * Connects to ECA's global SSE event stream (GET /api/v1/events), filters
 * events for a specific chatId, and dispatches them to handlers.
 *
 * Returns { req, done } where:
 *   req  — the underlying https.Request; call req.destroy() to cancel
 *   done — Promise that resolves when chat reaches 'idle' (or on error)
 *
 * handlers:
 *   onChunk(text)              — assistant text fragment (stream token)
 *   onAsk({ question, toolId })— ECA issued an ask_user tool call
 *   onToolLog(summary)         — tool call summary for progress display
 *   onDone()                   — chat reached 'idle' status
 *   onError(err)               — network or parse error
 */
function subscribeEcaEvents(chatId, { onChunk, onAsk, onToolLog, onDone, onError } = {}) {
  const base = new URL(ECA_SERVER_URL);
  let resolvePromise, rejectPromise;
  const done = new Promise((res, rej) => { resolvePromise = res; rejectPromise = rej; });

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

          // Filter by chatId — /api/v1/events is global (all chats)
          if (data.chatId !== chatId) continue;

          if (eventType === 'chat:content-received') {
            const { role, content } = data;
            if (!content) continue;
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
              // Tool call completed (after approval or auto-trust)
              if (content.type === 'toolCalled') {
                if (content.name === 'ask_user') {
                  const question = content.arguments?.question
                    || content.outputs?.[0]?.text || '(question ECA)';
                  if (onAsk) onAsk({ question, toolId: content.id, isApproval: false });
                } else if (onToolLog) {
                  onToolLog(content.summary || `[tool] ${content.name}`);
                }
              }
            }
          }

          if (eventType === 'chat:status-changed' && data.status === 'idle') {
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

module.exports = { ecaRequest, promptAndWait, lastAssistantText, subscribeEcaEvents };
