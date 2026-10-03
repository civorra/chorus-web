/**
 * eca-client.js — Client minimal pour le serveur ECA headless (mode remote)
 *
 * Protocole découvert/validé en session (cf. récapitulatif de session
 * 2026-10-02) :
 *   - Auth : header "Authorization: Bearer <ECA_REMOTE_PASSWORD>"
 *   - POST /api/v1/chats/:id/prompt { message }  → crée le chat si absent,
 *     envoie le prompt, répond immédiatement { status: "prompting" }
 *     (traitement asynchrone côté ECA)
 *   - GET  /api/v1/chats/:id                     → état complet du chat
 *     (messages, status: "prompting"|"idle"|..., pendingToolCalls)
 *   - Certificat TLS auto-signé (*.local.eca.dev) → rejectUnauthorized: false
 *     nécessaire (communication interne au réseau Docker Compose, jamais
 *     exposée à l'extérieur — acceptable dans ce contexte).
 *
 * Limite connue (MVP) : pas encore de consommation SSE — on poll
 * GET /api/v1/chats/:id jusqu'à status !== "prompting". Pas de vrai
 * streaming token-par-token côté navigateur pour l'instant (todo futur).
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

module.exports = { ecaRequest, promptAndWait, lastAssistantText };
