/**
 * server.js — Chorus Web MVP0 — point d'entrée
 *
 * Convention sandbox (réelle — cf. chorus/scanner.js § scanFlatProject) :
 *   workspace/<entity>/sources/*            → fichiers source déposés (flat)
 *   workspace/<entity>/<projId>.json        → projet aligné (chorus-import-project)
 *   workspace/<entity>/reports/*            → rapports (flat), reliés au projet par sous-chaîne
 * Aucun niveau 'default' : <entity> doit toujours être explicite.
 *
 * Structure modulaire :
 *   chorus/       → accès filesystem Chorus (scanner, parser, thésaurus, rapports)
 *   server/
 *     helpers/    → sse.js, perl.js
 *     routes/     → eca.js, scan.js, thesaurus.js, projects.js, terminal.js, reports.js
 *     state.js    → activeTerminals, latencyHistory
 *
 * Lancement :
 *   cp .env.example .env && nano .env
 *   npm install && node server.js
 */

'use strict';

// ── Charger .env ─────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

if (fs.existsSync(path.join(__dirname, '.env'))) {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split('\n')
    .forEach(line => {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
}

const express = require('express');
const chorus  = require('./chorus');
const auth    = require('./auth');

// ── Routers ───────────────────────────────────────────────────
const ecaRouter       = require('./server/routes/eca');
const scanRouter      = require('./server/routes/scan');
const thesaurusRouter = require('./server/routes/thesaurus');
const projectsRouter  = require('./server/routes/projects');
const terminalRouter  = require('./server/routes/terminal');
const reportsRouter   = require('./server/routes/reports');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

// ── Auth (avant les autres middlewares) ───────────────────────
app.use(auth);

// ── Middlewares ───────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Montage des routers sous /api ─────────────────────────────
app.use('/api/eca',     ecaRouter);
app.use('/api',         scanRouter);
app.use('/api',         thesaurusRouter);
app.use('/api',         projectsRouter);
app.use('/api',         terminalRouter);
app.use('/api',         reportsRouter);

// ── Frontend ──────────────────────────────────────────────────
const HTML_FILE = path.join(__dirname, 'chorus-web.html');

app.get('/', (req, res) => {
  if (fs.existsSync(HTML_FILE)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(HTML_FILE);
  } else {
    res.send(`
      <h2>Chorus Web MVP0</h2>
      <p>Placez <code>chorus-web.html</code> dans ce répertoire.</p>
      <p>API disponible sur <code>/api/</code></p>
    `);
  }
});

// ── Démarrage ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════════════╗`);
  console.log(`  ║   Chorus Web MVP0 — http://localhost:${PORT}  ║`);
  console.log(`  ╚═══════════════════════════════════════════╝\n`);

  try {
    console.log(`  CHORUS_HOME : ${chorus.CHORUS_HOME()}`);
  } catch {
    console.warn(`  ⚠  CHORUS_HOME non défini — éditez .env`);
  }

  const provider = process.env.ECA_DEFAULT_MODEL
    ? process.env.ECA_DEFAULT_MODEL.split('/')[0]
    : 'anthropic';
  if (!process.env.ANTHROPIC_API_KEY) {
    if (provider === 'anthropic') {
      console.warn(`  ⚠  ANTHROPIC_API_KEY non définie — vérifiez le secret Docker ou le provider ECA`);
    } else {
      console.log(`  ℹ  ANTHROPIC_API_KEY absente — provider actif : ${provider} (via eca-server)`);
    }
  }

  const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-5';
  console.log(`  Modèle LLM  : ${MODEL}\n`);
});
