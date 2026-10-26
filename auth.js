/**
 * auth.js — Gestion des credentials LLM (Phase 1 : API key manuelle + statut OAuth)
 *
 * Endpoints :
 *   GET  /api/auth/status           → état de tous les providers (ECA OAuth + webapp)
 *   POST /api/auth/apikey           → enregistrer une API key manuelle
 *   POST /api/auth/reload-eca       → redémarrer eca-server via Docker socket
 *
 * Sources de credentials (ordre de priorité) :
 *   1. OAUTH_CREDENTIALS (db.transit.json) — OAuth ECA natif (Emacs/Pro/Max)
 *   2. $CHORUS_HOME/.webapp-auth.json       — API keys gérées par la webapp
 *   3. ANTHROPIC_API_KEY env var             — clé injectée (fallback bootstrap)
 *
 * Aucune dépendance externe — http natif Node pour Docker socket.
 */

'use strict';

const fs      = require('fs');
const http    = require('http');
const https   = require('https');
const path    = require('path');
const crypto  = require('crypto');
const express = require('express');
const eca     = require('./eca-client');

const router = express.Router();

// ── Chemins ──────────────────────────────────────────────────

const OAUTH_CREDENTIALS  = () => {
  const p = process.env.OAUTH_CREDENTIALS || '';
  // Résoudre $HOME dans le chemin (transmis tel quel depuis .env)
  return p.replace(/^\$HOME/, process.env.HOME || '/root')
           .replace(/^~/, process.env.HOME || '/root');
};

const WEBAPP_AUTH_FILE   = () => {
  const base = process.env.CHORUS_HOME || '/chorus';
  return path.join(base, '.webapp-auth.json');
};

const ECA_CONTAINER_NAME = () =>
  process.env.ECA_CONTAINER_NAME || 'eca-server';

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

// ── Helpers — lecture ─────────────────────────────────────────

/**
 * Lit le credential store Transit JSON d'ECA (db.transit.json).
 * Format Transit/Clojure — on ne parse pas le Transit, on extrait
 * les informations utiles par pattern matching JSON brut.
 *
 * Retourne un tableau de { provider, mode, expiresAt } ou [] si absent.
 */
function readTransitAuth(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const results = [];

    // Anthropic : présence de "anthropic" + api-key/refresh-token
    if (raw.includes('"anthropic"') &&
        (raw.includes('api-key') || raw.includes('refresh-token'))) {
      // Extraire ~:mode (~:max, ~:pro, etc.) et ~:expires-at
      const modeMatch    = raw.match(/"~:mode","~:([^"]+)"/);
      const expiresMatch = raw.match(/"~:expires-at",(\d+)/);
      results.push({
        provider:  'anthropic',
        mode:      modeMatch ? modeMatch[1] : 'oauth',
        source:    'eca-native',
        expiresAt: expiresMatch ? parseInt(expiresMatch[1]) : null,
        active:    true,
      });
    }

    // GitHub Copilot : présence de "github-copilot" ou "copilot"
    if (raw.includes('"github-copilot"') || raw.includes('"copilot"')) {
      const expiresMatch = raw.match(/"~:expires-at",(\d+)/g);
      // Prendre le dernier expires-at (celui du Copilot si plusieurs)
      const lastExpires = expiresMatch
        ? parseInt(expiresMatch[expiresMatch.length - 1].match(/\d+/)[0])
        : null;
      results.push({
        provider:  'github-copilot',
        mode:      'oauth',
        source:    'eca-native',
        expiresAt: lastExpires,
        active:    true,
      });
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Lit .webapp-auth.json (format simple JSON géré par cette webapp).
 * Retourne un tableau de { provider, mode, expiresAt, active } ou [].
 */
function readWebappAuth(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const now  = Math.floor(Date.now() / 1000);
    return Object.entries(data).map(([provider, info]) => ({
      provider,
      mode:      info.source || 'apikey',
      source:    'webapp',
      expiresAt: info.expires_at || null,
      active:    !info.expires_at || info.expires_at > now,
    }));
  } catch {
    return [];
  }
}

/**
 * Lit ANTHROPIC_API_KEY depuis l'environnement (injectée par eca-bootstrap).
 */
function readEnvAuth() {
  if (process.env.ANTHROPIC_API_KEY) {
    return [{
      provider:  'anthropic',
      mode:      'env-apikey',
      source:    'env',
      expiresAt: null,
      active:    true,
    }];
  }
  return [];
}

// ── Helpers — écriture ────────────────────────────────────────

/**
 * Fusionne { provider: { api_key, ... } } dans .webapp-auth.json.
 * Crée le fichier s'il n'existe pas.
 */
function writeWebappAuth(filePath, provider, payload) {
  let current = {};
  try { current = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}
  current[provider] = { ...payload, updated_at: Math.floor(Date.now() / 1000) };
  fs.writeFileSync(filePath, JSON.stringify(current, null, 2), { mode: 0o600 });
}

// ── Helper — Docker restart ───────────────────────────────────

/**
 * Envoie POST /containers/{name}/restart à l'API Docker via socket Unix.
 * Retourne une Promise<{ ok, status, body }>.
 */
function dockerRestart(containerName) {
  return new Promise((resolve) => {
    if (!fs.existsSync(DOCKER_SOCKET)) {
      return resolve({ ok: false, status: 0, body: 'Docker socket introuvable — montez /var/run/docker.sock' });
    }

    const options = {
      socketPath: DOCKER_SOCKET,
      path:       `/containers/${encodeURIComponent(containerName)}/restart?t=5`,
      method:     'POST',
      headers:    { 'Content-Length': 0 },
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        // 204 No Content = succès Docker restart
        resolve({ ok: res.statusCode === 204, status: res.statusCode, body: body.trim() });
      });
    });

    req.on('error', (e) =>
      resolve({ ok: false, status: 0, body: e.message })
    );
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// ROUTE — GET /api/auth/status
//
// Agrège les sources de credentials et retourne l'état complet.
// Réponse :
//   {
//     ok: true,
//     sources: [{ provider, mode, source, expiresAt, active }],
//     summary: { anthropic: 'eca-native'|'webapp'|'env'|null,
//                'github-copilot': ... }
//   }
// ═══════════════════════════════════════════════════════════════

router.get('/api/auth/status', (req, res) => {
  const transitPath = OAUTH_CREDENTIALS();
  const webappPath  = WEBAPP_AUTH_FILE();

  const transitSources = transitPath ? readTransitAuth(transitPath) : [];
  const webappSources  = readWebappAuth(webappPath);
  const envSources     = readEnvAuth();

  // Fusion : priorité transit > webapp > env ; déduplique par provider
  const seen    = new Set();
  const sources = [];
  for (const s of [...transitSources, ...webappSources, ...envSources]) {
    if (!seen.has(s.provider)) {
      seen.add(s.provider);
      sources.push(s);
    }
  }

  // Résumé par provider
  const summary = {};
  for (const s of sources) {
    summary[s.provider] = s.active ? s.source : 'expired';
  }

  // Infos sur les fichiers (présence, taille)
  const files = {};
  if (transitPath) {
    try {
      const st = fs.statSync(transitPath);
      files['oauth-credentials'] = { path: transitPath, size: st.size, exists: true };
    } catch {
      files['oauth-credentials'] = { path: transitPath, exists: false };
    }
  }
  try {
    const st = fs.statSync(webappPath);
    files['webapp-auth'] = { path: webappPath, size: st.size, exists: true };
  } catch {
    files['webapp-auth'] = { path: webappPath, exists: false };
  }

  res.json({ ok: true, sources, summary, files });
});

// ═══════════════════════════════════════════════════════════════
// ROUTE — POST /api/auth/apikey
//
// Body JSON : { provider: 'anthropic'|'github-copilot', apiKey: string }
//
// Écrit dans .webapp-auth.json puis déclenche un reload d'eca-server.
// Réponse : { ok, provider, reload: { ok, status, body } }
// ═══════════════════════════════════════════════════════════════

router.post('/api/auth/apikey', express.json(), (req, res) => {
  const { provider, apiKey } = req.body || {};

  if (!provider || !['anthropic', 'github-copilot'].includes(provider)) {
    return res.status(400).json({ ok: false, error: 'provider invalide (anthropic | github-copilot)' });
  }
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
    return res.status(400).json({ ok: false, error: 'apiKey manquante ou trop courte' });
  }

  const webappPath = WEBAPP_AUTH_FILE();

  // Payload selon le provider
  const payload = provider === 'anthropic'
    ? { api_key: apiKey.trim(), source: 'manual-apikey' }
    : { access_token: apiKey.trim(), source: 'manual-apikey' };

  try {
    writeWebappAuth(webappPath, provider, payload);
  } catch (e) {
    return res.status(500).json({ ok: false, error: `Écriture .webapp-auth.json : ${e.message}` });
  }

  // Déclencher le reload d'eca-server (best-effort — pas bloquant)
  dockerRestart(ECA_CONTAINER_NAME()).then((reload) => {
    res.json({ ok: true, provider, webappAuthFile: webappPath, reload });
  });
});

// ═══════════════════════════════════════════════════════════════
// ROUTE — POST /api/auth/reload-eca
//
// Redémarre eca-server via Docker socket.
// Utile aussi pour forcer un rechargement après modification manuelle
// de db.transit.json ou .webapp-auth.json.
// Réponse : { ok, container, result: { ok, status, body } }
// ═══════════════════════════════════════════════════════════════

router.post('/api/auth/reload-eca', express.json(), async (req, res) => {
  const containerName = (req.body && req.body.container) || ECA_CONTAINER_NAME();
  const result = await dockerRestart(containerName);
  res.json({ ok: result.ok, container: containerName, result });
});

// ══════════════════════════════════════════════════════════════
// ECA LOGIN — Anthropic : OAuth natif Node.js (zéro dépendance ECA locale).
//            GitHub Copilot : pilotage du flow conversationnel natif
//            d'ECA (`/login github`) — voir eca-client.js §
//            subscribeLoginFlow pour le détail du protocole et son
//            avertissement critique (connexion SSE à garder ouverte).
//
// ⚠️ Historique (2026-10-17) : la première implémentation de ce fichier
// réimplémentait le Device Flow GitHub (RFC 8628) en Node.js pur et stockait
// le token obtenu dans .webapp-auth.json, relayé à eca-server via la
// variable d'environnement GITHUB_COPILOT_TOKEN (eca-bootstrap.sh). Ce
// mécanisme s'est avéré non fonctionnel : confirmé par inspection binaire
// qu'aucune version d'ECA testée (0.164.0/0.165.0/0.165.1) ne lit cette
// variable — le Device Flow aboutissait bien côté GitHub, mais ECA ne
// voyait jamais la session et continuait de répondre
// "No available model found". ECA attend ses credentials Copilot
// exclusivement via son propre store OAuth natif (~/.cache/eca/db.transit.json,
// écrit par ECA lui-même). Remplacé par le pilotage direct de la commande
// `/login github` d'ECA, qui écrit cette session lui-même — validé de bout
// en bout (device-code affiché → validation humaine → "Login successful!"
// → db.transit.json peuplé dans le conteneur, sans dépendance à l'hôte).
// ══════════════════════════════════════════════════════════════

// ── OAuth constants (anthropic uniquement — copilot n'en a plus besoin) ──

// Valeurs par défaut = client_ids extraits du binaire ECA (eca.dev).
// Surchargeables via .env si vous enregistrez vos propres OAuth Apps.
const ANTHROPIC_CLIENT_ID  = process.env.ANTHROPIC_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_SCOPE      = process.env.ANTHROPIC_OAUTH_SCOPE     || 'org:create_api_key user:profile user:inference';
const ANTHROPIC_REDIRECT   = 'https://console.anthropic.com/oauth/code/callback';
const ANTHROPIC_AUTH_URL   = 'https://claude.ai/oauth/authorize';
const ANTHROPIC_TOKEN_URL  = 'https://console.anthropic.com/v1/oauth/token';
const ANTHROPIC_APIKEY_URL = 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key';

// ── PKCE helpers ─────────────────────────────────────────────

function generatePKCE() {
  const verifier  = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ── HTTPS helper ─────────────────────────────────────────────

function httpsPost(urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const u    = new URL(urlStr);
    const isForm = (headers['Content-Type'] || '').includes('x-www-form-urlencoded');
    const data = isForm
      ? new URLSearchParams(body).toString()
      : JSON.stringify(body);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + (u.search || ''),
      method:   'POST',
      // ⚠️ User-Agent obligatoire : console.anthropic.com/v1/oauth/token retourne
      // 400 "Invalid request format" sans User-Agent reconnu (curl/7.88+, Mozilla/5.0).
      // Node.js n'en envoie pas par défaut, contrairement à curl.
      headers:  { 'User-Agent': 'Mozilla/5.0 (chorus-web)', ...headers, 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(d); } catch { parsed = d; }
        // Capturer les headers de réponse (Retry-After, X-RateLimit-*, etc.)
        resolve({ status: res.statusCode, data: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Session store (in-memory, TTL 10 min) ────────────────────

const ecaSessions = new Map();

function makeSession(id, provider, extra) {
  const s = { id, provider, ...extra };
  s.ttl = setTimeout(() => ecaSessions.delete(id), 10 * 60 * 1000);
  ecaSessions.set(id, s);
  return s;
}
function dropSession(id) {
  const s = ecaSessions.get(id);
  if (s) {
    clearTimeout(s.ttl);
    if (s.ecaSub) { try { s.ecaSub.destroy(); } catch {} }
    ecaSessions.delete(id);
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTE — POST /api/auth/eca-login/start
//
// Body : { provider: 'anthropic' | 'github-copilot' }
//
// Anthropic  → PKCE + OOB : retourne { action:'authorize', url, fields }
//              L'user ouvre url → s'authentifie → Anthropic affiche un code
//              → l'user colle le code → /submit
//
// Copilot    → Device Flow : retourne { action:'device-code', url, userCode }
//              L'user va sur url, entre userCode → /wait (SSE polling)
// ═══════════════════════════════════════════════════════════════

router.post('/api/auth/eca-login/start', express.json(), async (req, res) => {
  const { provider } = req.body || {};
  if (!['anthropic', 'github-copilot'].includes(provider)) {
    return res.status(400).json({ ok: false, error: 'provider invalide (anthropic | github-copilot)' });
  }

  const sessionId = `oauth-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  try {
    if (provider === 'anthropic') {
      // ── Anthropic PKCE ─────────────────────────────────────
      const { verifier, challenge } = generatePKCE();
      const state = crypto.randomBytes(16).toString('hex');
      const params = new URLSearchParams({
        response_type:         'code',
        client_id:             ANTHROPIC_CLIENT_ID,
        redirect_uri:          ANTHROPIC_REDIRECT,
        scope:                 ANTHROPIC_SCOPE,
        code_challenge:        challenge,
        code_challenge_method: 'S256',
        state,
      });
      const url = `${ANTHROPIC_AUTH_URL}?${params}`;
      makeSession(sessionId, provider, { verifier, state });
      return res.json({
        ok: true, sessionId, action: 'authorize', url,
        fields:  [{ key: 'code', label: 'Code d\'autorisation', type: 'secret' }],
        message: 'Ouvrez ce lien, authentifiez-vous, puis collez le code affiché :',
      });
    }

    // ── GitHub Copilot — pilotage du flow conversationnel ECA natif ──
    // Ouvre un chat système dédié, lance '/login github', répond à la
    // question ask-question avec le label exact 'github-copilot', puis
    // s'abonne au flux SSE (subscribeLoginFlow) pour intercepter le
    // user_code + verification_uri dès qu'ECA les affiche. La connexion
    // SSE est maintenue ouverte et transmise au store de session : c'est
    // elle qui portera ensuite le polling jusqu'à /wait (voir avertissement
    // critique dans eca-client.js § subscribeLoginFlow — NE JAMAIS la
    // fermer avant succès/échec confirmé).
    const chatId = `eca-login-copilot-${sessionId}`;

    const codeReady = await new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        sub.destroy();
        reject(new Error('Délai dépassé en attente du code GitHub (20s)'));
      }, 20000);

      const sub = eca.subscribeLoginFlow(chatId, {
        onQuestion: ({ options }) => {
          // Répond uniquement à la 1ère question (choix du provider) —
          // github-copilot n'a pas de sous-question supplémentaire,
          // contrairement à anthropic (max/console/manual).
          const match = options.find(o => o.label === 'github-copilot');
          if (match) eca.sendLoginStep(chatId, 'github-copilot').catch(() => {});
        },
        onCodeReady: ({ url, code }) => {
          clearTimeout(timeoutHandle);
          resolve({ url, code, sub });
        },
        onError: (e) => {
          clearTimeout(timeoutHandle);
          reject(e);
        },
        onCancelled: () => {
          clearTimeout(timeoutHandle);
          reject(new Error('Login annulé côté ECA'));
        },
      });

      // Démarre le flow — la réponse à la ask-question est envoyée par
      // onQuestion ci-dessus dès qu'elle arrive sur le flux SSE.
      eca.sendLoginStep(chatId, '/login github').catch((e) => {
        clearTimeout(timeoutHandle);
        sub.destroy();
        reject(e);
      });
    });

    // Conserve la souscription SSE active dans la session — /wait la
    // réutilisera pour attendre onSuccess (ne pas la détruire ici).
    makeSession(sessionId, provider, { chatId, ecaSub: codeReady.sub });
    return res.json({
      ok: true, sessionId, action: 'device-code',
      url:      codeReady.url,
      userCode: codeReady.code,
      message:  'Ouvrez ce lien et entrez le code ci-dessous :',
    });

  } catch (e) {
    dropSession(sessionId);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE — POST /api/auth/eca-login/:sessionId/submit
//
// Anthropic uniquement : { data: { code: string } }
// Échange le code contre un token OAuth puis crée une API key.
// Écrit dans .webapp-auth.json + restart eca-server.
// ═══════════════════════════════════════════════════════════════

router.post('/api/auth/eca-login/:sessionId/submit', express.json(), async (req, res) => {
  const session = ecaSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'Session introuvable ou expirée' });
  if (session.provider !== 'anthropic') {
    return res.status(400).json({ ok: false, error: 'submit uniquement pour le provider anthropic (Copilot utilise /wait)' });
  }

  // Anthropic OOB affiche "code#state" — l'utilisateur copie tout.
  // On tronque au premier '#' pour n'envoyer que le code au token endpoint.
  const rawCode = (req.body && req.body.data && req.body.data.code || '').trim();
  const code = rawCode.split('#')[0].trim();
  if (!code) return res.status(400).json({ ok: false, error: 'code manquant' });

  try {
    // 1. Échanger le code contre un access_token
    // ⚠️ L'endpoint console.anthropic.com/v1/oauth/token exige application/json
    // (plus application/x-www-form-urlencoded) — "Invalid request format" sinon.
    const tokenRes = await httpsPost(
      ANTHROPIC_TOKEN_URL,
      {
        grant_type:    'authorization_code',
        code,
        client_id:     ANTHROPIC_CLIENT_ID,
        redirect_uri:  ANTHROPIC_REDIRECT,
        code_verifier: session.verifier,
      },
      { 'Content-Type': 'application/json', Accept: 'application/json' }
    );
    if (tokenRes.status !== 200 || !tokenRes.data.access_token) {
      // Cas rate limit (HTTP 429) : extraire Retry-After si disponible
      const isRateLimit =
        tokenRes.status === 429 ||
        (tokenRes.data && tokenRes.data.error && tokenRes.data.error.type === 'rate_limit_error');
      if (isRateLimit) {
        const retryAfter = tokenRes.headers && (
          tokenRes.headers['retry-after'] ||
          tokenRes.headers['x-ratelimit-reset-requests'] ||
          tokenRes.headers['x-ratelimit-reset']
        );
        // Log complet pour diagnostic (visible dans `docker logs chorus-web`)
        console.error('[auth] OAuth 429 rate-limit — status:', tokenRes.status,
          '| retryAfter:', retryAfter || '(absent)',
          '| headers:', JSON.stringify(tokenRes.headers),
          '| body:', JSON.stringify(tokenRes.data));
        const waitMsg = retryAfter
          ? ` Réessayez dans ${retryAfter} seconde(s).`
          : ' Réessayez dans quelques heures (limite par IP/client_id sur console.anthropic.com).';
        return res.status(429).json({
          ok:         false,
          rateLimited: true,
          error:      `Anthropic OAuth : trop de tentatives d'échange de token.${waitMsg}`,
          detail:     tokenRes.data,
          retryAfter: retryAfter || null,
        });
      }
      console.error('[auth] OAuth token exchange failed — status:', tokenRes.status,
        '| headers:', JSON.stringify(tokenRes.headers),
        '| body:', JSON.stringify(tokenRes.data));
      return res.status(401).json({
        ok:     false,
        error:  `Échange token échoué (HTTP ${tokenRes.status}) : ${JSON.stringify(tokenRes.data)}`,
        detail: tokenRes.data,
      });
    }
    const accessToken = tokenRes.data.access_token;

    // 2. Créer une API key persistante depuis le token OAuth
    const keyRes = await httpsPost(
      ANTHROPIC_APIKEY_URL,
      {},
      { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' }
    );
    if (keyRes.status !== 200 || !keyRes.data.api_key) {
      return res.status(502).json({
        ok:     false,
        error:  `Création API key échouée (HTTP ${keyRes.status}) : ${JSON.stringify(keyRes.data)}`,
        detail: keyRes.data,
      });
    }
    const apiKey     = keyRes.data.api_key;
    const expiresAt  = tokenRes.data.expires_in
      ? Math.floor(Date.now() / 1000) + tokenRes.data.expires_in
      : null;

    // 3. Stocker dans .webapp-auth.json
    writeWebappAuth(WEBAPP_AUTH_FILE(), 'anthropic', {
      api_key:    apiKey,
      expires_at: expiresAt,
      source:     'oauth-pkce',
    });
    dropSession(sessionId);

    // 4. Restart eca-server (best-effort)
    const reload = await dockerRestart(ECA_CONTAINER_NAME()).catch(e => ({ ok: false, body: e.message }));
    res.json({ ok: true, done: true, action: 'done', reload });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE — GET /api/auth/eca-login/:sessionId/wait  (SSE)
//
// GitHub Copilot : relaie les événements de la souscription ECA déjà
// active (session.ecaSub, créée par /start — voir subscribeLoginFlow).
// N'effectue plus de polling GitHub direct : c'est ECA qui poll en
// interne tant que la connexion /api/v1/events qu'on a ouverte depuis
// /start reste vivante (voir avertissement critique eca-client.js).
// Events SSE renvoyés au frontend (inchangé) : ping · done { provider } · error { message }
// ═══════════════════════════════════════════════════════════════

router.get('/api/auth/eca-login/:sessionId/wait', (req, res) => {
  const session = ecaSessions.get(req.params.sessionId);

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  if (!session || !session.ecaSub) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'Session introuvable, expirée, ou sans flow ECA actif' })}\n\n`);
    return res.end();
  }

  const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 15000);
  let   done = false;

  // Timeout de sécurité — la session device-code GitHub expire généralement
  // sous 15 min ; on borne ici à 10 min pour rester cohérent avec le TTL de
  // session déjà en place (makeSession).
  const expTimer = setTimeout(
    () => finish(false, { message: 'Délai d\'autorisation expiré — relancez le flow' }),
    9 * 60 * 1000
  );

  const finish = (ok, payload) => {
    if (done) return;
    done = true;
    clearInterval(ping);
    clearTimeout(expTimer);
    if (ok) {
      dockerRestart(ECA_CONTAINER_NAME()).catch(() => {});
      res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
    } else {
      res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    res.end();
    dropSession(session.id); // ferme aussi session.ecaSub (voir dropSession)
  };

  // Ré-attache les handlers onSuccess/onCancelled/onError de la souscription
  // déjà ouverte depuis /start — subscribeLoginFlow ne les a pas fixés à la
  // création (seuls onQuestion/onCodeReady l'étaient, voir route /start),
  // donc on complète ici en patchant les callbacks exposés par l'objet sub.
  // (subscribeLoginFlow garde une référence interne aux handlers passés à
  // sa création ; comme /start n'a fourni ni onSuccess ni onCancelled, il
  // faut les attacher maintenant pour que le flux déjà actif les déclenche.)
  session.ecaSub.setHandlers?.({
    onSuccess: () => finish(true, { provider: session.provider }),
    onCancelled: () => finish(false, { message: 'Login annulé côté ECA' }),
    onError: (e) => finish(false, { message: e.message }),
  });

  if (req.socket) req.socket.on('close', () => { clearInterval(ping); clearTimeout(expTimer); });
});

// ═══════════════════════════════════════════════════════════════
// ROUTE — DELETE /api/auth/eca-login/:sessionId
// Annule une session de login en cours.
// ═══════════════════════════════════════════════════════════════

router.delete('/api/auth/eca-login/:sessionId', (req, res) => {
  dropSession(req.params.sessionId);
  res.json({ ok: true });
});

module.exports = router;
