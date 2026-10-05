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
const path    = require('path');
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

module.exports = router;
