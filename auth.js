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
// ECA LOGIN — OAuth natif Node.js (zéro dépendance ECA locale)
//
// Réplique exactement le workflow /login d'Emacs ECA en appelant
// directement les endpoints OAuth des providers. Aucun binaire ECA,
// aucun Emacs, aucune dépendance externe — http/https/crypto Node.js natifs.
//
// Providers et flows :
//   anthropic     → PKCE + OOB (code affiché sur console.anthropic.com)
//   github-copilot → Device Flow RFC 8628 (code + polling GitHub)
// ══════════════════════════════════════════════════════════════

// ── OAuth constants ───────────────────────────────────────────

// Valeurs par défaut = client_ids extraits du binaire ECA (eca.dev).
// Surchargeables via .env si vous enregistrez vos propres OAuth Apps.
const ANTHROPIC_CLIENT_ID  = process.env.ANTHROPIC_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_SCOPE      = process.env.ANTHROPIC_OAUTH_SCOPE     || 'org:create_api_key user:profile user:inference';
const ANTHROPIC_REDIRECT   = 'https://console.anthropic.com/oauth/code/callback';
const ANTHROPIC_AUTH_URL   = 'https://claude.ai/oauth/authorize';
const ANTHROPIC_TOKEN_URL  = 'https://console.anthropic.com/v1/oauth/token';
const ANTHROPIC_APIKEY_URL = 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key';

const COPILOT_CLIENT_ID    = process.env.COPILOT_OAUTH_CLIENT_ID   || 'Iv1.b507a08c87ecfe98';
const COPILOT_DEVICE_URL   = 'https://github.com/login/device/code';
const COPILOT_TOKEN_URL    = 'https://github.com/login/oauth/access_token';
const COPILOT_GRANT_TYPE   = 'urn:ietf:params:oauth:grant-type:device_code';

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
      headers:  { ...headers, 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(d); } catch { parsed = d; }
        resolve({ status: res.statusCode, data: parsed });
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
  if (s) { clearTimeout(s.ttl); ecaSessions.delete(id); }
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

    // ── GitHub Copilot Device Flow ──────────────────────────
    const r = await httpsPost(
      COPILOT_DEVICE_URL,
      { client_id: COPILOT_CLIENT_ID, scope: '' },
      { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
    );
    if (r.status !== 200 || !r.data.device_code) {
      return res.status(502).json({ ok: false, error: `GitHub device/code : HTTP ${r.status} — ${JSON.stringify(r.data)}` });
    }
    const { device_code, user_code, verification_uri, expires_in, interval } = r.data;
    makeSession(sessionId, provider, { device_code, interval: (interval || 5) * 1000, expiresAt: Date.now() + expires_in * 1000 });
    return res.json({
      ok: true, sessionId, action: 'device-code',
      url:      verification_uri,
      userCode: user_code,
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

  const code = (req.body && req.body.data && req.body.data.code || '').trim();
  if (!code) return res.status(400).json({ ok: false, error: 'code manquant' });

  try {
    // 1. Échanger le code contre un access_token
    const tokenRes = await httpsPost(
      ANTHROPIC_TOKEN_URL,
      {
        grant_type:    'authorization_code',
        code,
        client_id:     ANTHROPIC_CLIENT_ID,
        redirect_uri:  ANTHROPIC_REDIRECT,
        code_verifier: session.verifier,
      },
      { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
    );
    if (tokenRes.status !== 200 || !tokenRes.data.access_token) {
      return res.status(401).json({ ok: false, error: `Échange token échoué : ${JSON.stringify(tokenRes.data)}` });
    }
    const accessToken = tokenRes.data.access_token;

    // 2. Créer une API key persistante depuis le token OAuth
    const keyRes = await httpsPost(
      ANTHROPIC_APIKEY_URL,
      {},
      { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' }
    );
    if (keyRes.status !== 200 || !keyRes.data.api_key) {
      return res.status(502).json({ ok: false, error: `Création API key échouée : ${JSON.stringify(keyRes.data)}` });
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
// GitHub Copilot Device Flow : poll jusqu'à obtention du token.
// Écrit dans .webapp-auth.json + restart eca-server.
// Events SSE : ping · done { provider } · error { message }
// ═══════════════════════════════════════════════════════════════

router.get('/api/auth/eca-login/:sessionId/wait', (req, res) => {
  const session = ecaSessions.get(req.params.sessionId);

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  if (!session) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'Session introuvable ou expirée' })}\n\n`);
    return res.end();
  }

  const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 15000);
  let   done = false;

  const finish = (ok, payload) => {
    if (done) return;
    done = true;
    clearInterval(ping);
    clearTimeout(expTimer);
    if (ok) {
      dropSession(session.id);
      dockerRestart(ECA_CONTAINER_NAME()).catch(() => {});
      res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
    } else {
      res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    res.end();
  };

  const expTimer = setTimeout(
    () => finish(false, { message: 'Délai d\'autorisation expiré — relancez le flow' }),
    session.expiresAt - Date.now()
  );

  // Polling GitHub
  const poll = async () => {
    if (done) return;
    try {
      const r = await httpsPost(
        COPILOT_TOKEN_URL,
        { client_id: COPILOT_CLIENT_ID, device_code: session.device_code, grant_type: COPILOT_GRANT_TYPE },
        { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
      );
      if (r.data.access_token) {
        writeWebappAuth(WEBAPP_AUTH_FILE(), 'github-copilot', {
          access_token: r.data.access_token,
          token_type:   r.data.token_type || 'bearer',
          scope:        r.data.scope || '',
          source:       'device-flow',
        });
        return finish(true, { provider: 'github-copilot' });
      }
      // authorization_pending ou slow_down → continuer à poller
      if (!r.data.error || r.data.error === 'authorization_pending' || r.data.error === 'slow_down') {
        const interval = r.data.error === 'slow_down' ? session.interval * 2 : session.interval;
        setTimeout(poll, interval);
      } else {
        finish(false, { message: `GitHub OAuth : ${r.data.error_description || r.data.error}` });
      }
    } catch (e) {
      setTimeout(poll, session.interval); // erreur réseau → retry
    }
  };
  setTimeout(poll, session.interval);
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
