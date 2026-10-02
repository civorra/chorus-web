/**
 * server.js — Chorus Web MVP0
 *
 * Convention sandbox (réelle — cf. chorus.js § scanFlatProject) :
 *   workspace/<entity>/sources/*            → fichiers source déposés (flat)
 *   workspace/<entity>/<projId>.json        → projet aligné (chorus-import-project), un fichier = un projet
 *   workspace/<entity>/reports/*            → rapports (flat), reliés au projet par sous-chaîne <projId>
 * Convention alternative conservée en fallback : workspace/<entity>/sources/<projId>/frames.pl
 * Aucun niveau 'default' : <entity> doit toujours être explicite.
 *
 * Endpoints :
 *   GET  /api/scan                                                        → scan $CHORUS_HOME (sandboxes + entities + projets)
 *   POST /api/sandboxes/:sbId/entities/:entityId/projects/import          → chorus-import-project (SSE)
 *   POST /api/sandboxes/:sbId/entities/:entityId/projects/:projId/run     → run.pl (SSE)
 *   GET  /api/sandboxes/:sbId/entities/:entityId/projects/:projId/check   → chorus-check via LLM (SSE)
 *   POST /api/sandboxes/:sbId/entities/:entityId/projects/:projId/chat    → session ECA interactive
 *   GET  /                                                                → sert chorus-web.html
 *
 * Lancement :
 *   cp .env.example .env && nano .env
 *   npm install
 *   node server.js
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

const express  = require('express');
const multer   = require('multer');
const { spawn } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');

const chorus  = require('./chorus');
const prompts = require('./prompts');

const app    = express();
const PORT   = parseInt(process.env.PORT || '3000');
const PERL   = process.env.PERL_BIN || 'perl';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = process.env.ANTHROPIC_MODEL || 'claude-opus-4-5';

// ── Multer : upload dans /tmp ─────────────────────────────────
const upload = multer({
  dest: path.join(require('os').tmpdir(), 'chorus-uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

// ── Middleware ────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Helper SSE ────────────────────────────────────────────────

function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseDone(res, data = {}) {
  sseSend(res, 'done', data);
  res.end();
}

function sseError(res, message) {
  sseSend(res, 'error', { message });
  res.end();
}

// ── Spawn Perl avec streaming SSE ────────────────────────────

function spawnPerl(args, cwd, res, onDone) {
  const proc = spawn(PERL, args, { cwd, env: process.env });

  proc.stdout.on('data', chunk => {
    chunk.toString().split('\n').forEach(line => {
      if (line.trim()) sseSend(res, 'log', { line });
    });
  });

  proc.stderr.on('data', chunk => {
    chunk.toString().split('\n').forEach(line => {
      if (line.trim()) sseSend(res, 'log', { line, level: 'warn' });
    });
  });

  proc.on('close', code => {
    if (code === 0) {
      onDone();
    } else {
      sseError(res, `Processus terminé avec code ${code}`);
    }
  });

  proc.on('error', err => {
    sseError(res, `Impossible de lancer perl : ${err.message}`);
  });

  return proc;
}

// ═════════════════════════════════════════════════════════════
// ROUTE 1 — GET /api/scan
// Scan $CHORUS_HOME → liste sandboxes + projets existants
// ═════════════════════════════════════════════════════════════

app.get('/api/scan', (req, res) => {
  try {
    const sandboxes = chorus.scanAll();
    res.json({ ok: true, sandboxes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Scan d'un sandbox individuel (après import ou refresh)
app.get('/api/sandboxes/:sbId', (req, res) => {
  try {
    const sb = chorus.scanSandbox(req.params.sbId);
    res.json({ ok: true, sandbox: sb });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// ROUTE 2 — POST /api/sandboxes/:sbId/entities/:entityId/projects/import
//
// Body (multipart/form-data) :
//   file     : le PDF/DOCX à importer
//   projId   : identifiant cible (slug)
//   model    : modèle LLM pour chorus-import-project (optionnel)
//
// L'entity est portée par l'URL — pas de valeur par défaut, elle doit
// exister explicitement (aucun niveau 'default').
//
// SSE events : log { line, level? } | done { project } | error { message }
// ═════════════════════════════════════════════════════════════

app.post('/api/sandboxes/:sbId/entities/:entityId/projects/import',
  upload.single('file'),
  (req, res) => {
    sseInit(res);

    const { sbId, entityId } = req.params;
    const projId    = req.body.projId  || `proj-${Date.now()}`;
    const llmModel  = req.body.model   || MODEL;
    const uploadedFile = req.file;

    if (!uploadedFile) return sseError(res, 'Fichier manquant');
    if (!entityId)     return sseError(res, 'entityId manquant dans l\'URL');

    // Déplacer le fichier dans workspace/<entityId>/sources/<projId>/
    let sbPath;
    try {
      sbPath = path.join(chorus.SANDBOXES_DIR(), sbId);
    } catch (e) {
      return sseError(res, e.message);
    }

    const entityPath = path.join(sbPath, 'workspace', entityId);
    const srcDir      = path.join(entityPath, 'sources', projId);
    fs.mkdirSync(srcDir, { recursive: true });

    const ext      = path.extname(uploadedFile.originalname) || '.pdf';
    const destFile = path.join(srcDir, `source${ext}`);
    fs.renameSync(uploadedFile.path, destFile);

    sseSend(res, 'log', { line: `→ Source : ${uploadedFile.originalname} → workspace/${entityId}/sources/${projId}/source${ext}` });
    sseSend(res, 'log', { line: `→ Lancement chorus-import-project …` });

    // chorus-import-project prend en argument le fichier source et le répertoire cible
    // Adapter les args selon l'interface réelle de chorus-import-project
    const args = [
      'chorus-import-project.pl',
      '--input',  destFile,
      '--output', srcDir,
      '--id',     projId,
      '--ctx',    entityId,
      '--model',  llmModel,
    ];

    spawnPerl(args, chorus.CHORUS_HOME(), res, () => {
      // Relire le projet après import
      try {
        const proj = chorus.scanProject(entityPath, projId);
        sseSend(res, 'log', { line: `✓ Import terminé — ${proj.frames} frames extraites` });
        sseDone(res, { project: proj });
      } catch (e) {
        sseDone(res, { project: { id: projId, state: 'imported' } });
      }
    });
  }
);

// ═════════════════════════════════════════════════════════════
// ROUTE 3 — POST /api/sandboxes/:sbId/entities/:entityId/projects/:projId/run
//
// Lance run.pl sur le projet.
//
// Interface réelle de run.pl (généré par chorus-check à la racine du
// sandbox — PAS dans CHORUS_HOME) :
//   perl run.pl <fichier-project.json>      ← cwd = racine du sandbox ($Bin)
// → écrit <sandbox>/reports/run-report-<timestamp>.json (JSON structuré,
//   distinct de workspace/<entity>/reports/ qui contient les rapports
//   chorus-import-project / chorus-check).
//
// SSE events : log { line, level? } | done { reportFile, reportData } | error
// ═════════════════════════════════════════════════════════════

app.post('/api/sandboxes/:sbId/entities/:entityId/projects/:projId/run', (req, res) => {
  sseInit(res);

  const { sbId, entityId, projId } = req.params;

  let sbPath;
  try {
    sbPath = path.join(chorus.SANDBOXES_DIR(), sbId);
  } catch (e) {
    return sseError(res, e.message);
  }

  const entityPath = path.join(sbPath, 'workspace', entityId);
  const runPl       = path.join(sbPath, 'run.pl');

  // Convention réelle : workspace/<entity>/<projId>.json (projet aligné par
  // chorus-import-project — voir chorus.js § scanFlatProject).
  // Fallback legacy : workspace/<entity>/sources/<projId>/frames.pl.
  const flatProjectFile  = path.join(entityPath, `${projId}.json`);
  const legacyFramesFile = path.join(entityPath, 'sources', projId, 'frames.pl');

  let inputFile = null;
  if (fs.existsSync(flatProjectFile)) {
    inputFile = flatProjectFile;
  } else if (fs.existsSync(legacyFramesFile)) {
    inputFile = legacyFramesFile;
  } else {
    return sseError(res, `Projet introuvable : ni ${projId}.json ni sources/${projId}/frames.pl — lancez d'abord l'import`);
  }

  if (!fs.existsSync(runPl)) {
    return sseError(res, `run.pl introuvable à la racine du sandbox (${runPl}) — générez-le d'abord via le skill chorus-check`);
  }

  sseSend(res, 'log', { line: `→ perl run.pl ${inputFile}` });

  // run.pl doit être lancé avec cwd = racine du sandbox ($Bin interne au
  // script : lib/, rules/, reports/ y sont tous relatifs).
  const args = ['run.pl', inputFile];

  spawnPerl(args, sbPath, res, () => {
    // run.pl écrit son rapport JSON dans <sandbox>/reports/run-report-*.json
    // SANS identifiant de projet dans le nom de fichier — le seul lien
    // fiable est le champ interne `project_file` (chemin absolu passé en
    // argument à run.pl, ici = inputFile). On ne peut donc PAS se contenter
    // de prendre "le fichier le plus récent du dossier" : si un autre projet
    // vient d'être lancé entre-temps, on retournerait le mauvais rapport.
    const sbReportsDir = path.join(sbPath, 'reports');
    let reportFile = null;
    let reportData = null;
    try {
      const files = fs.readdirSync(sbReportsDir)
        .filter(f => f.startsWith('run-report-') && f.endsWith('.json'))
        .sort(); // ordre croissant par timestamp (nom de fichier)

      // On part de la fin (plus récent en premier) et on garde le premier
      // dont project_file correspond exactement au projet lancé ici.
      for (let i = files.length - 1; i >= 0; i--) {
        const f = files[i];
        try {
          const json = JSON.parse(fs.readFileSync(path.join(sbReportsDir, f), 'utf8'));
          if (json.project_file !== inputFile) continue;
          reportFile = f;
          reportData = {
            verdict:      json.pipeline_solved ? 'SOLVED' : 'FAILED',
            totalFrames:  json.n_total ?? 0,
            conformes:    json.n_conforme ?? 0,
            nonConformes: json.n_non_conforme ?? 0,
            aConfirmer:   json.n_incertain ?? 0,
            norm:         null,
            date:         (json.generated_at || '').slice(0, 10) || null,
          };
          break;
        } catch { /* fichier corrompu/illisible — on continue */ }
      }
    } catch {}

    if (reportFile) {
      sseSend(res, 'log', { line: `✓ Rapport généré : reports/${reportFile}` });
      sseSend(res, 'log', {
        line: `  Verdict : ${reportData.verdict} — ${reportData.conformes}/${reportData.totalFrames} CONFORMES`
      });
    } else {
      sseSend(res, 'log', {
        line: `⚠ Aucun run-report-*.json trouvé pour project_file=${inputFile} après run.pl`,
        level: 'warn'
      });
    }

    sseDone(res, { reportFile, reportData });
  });
});

// ═════════════════════════════════════════════════════════════
// ROUTE 4 — GET /api/sandboxes/:sbId/entities/:entityId/projects/:projId/check
//
// Query params : action=summary|explain
// Lit compliance-report-*.md (dans reports/) → LLM → stream SSE du texte généré
// SSE events : chunk { text } | done { filename } | error
// ═════════════════════════════════════════════════════════════

app.get('/api/sandboxes/:sbId/entities/:entityId/projects/:projId/check', async (req, res) => {
  sseInit(res);

  const { sbId, entityId, projId } = req.params;
  const action = (req.query.action || 'summary').toLowerCase();

  if (!['summary', 'explain', 'complete-report'].includes(action)) {
    return sseError(res, `action invalide : ${action} (summary | explain | complete-report)`);
  }

  // Trouver le rapport source :
  //   complete-report → lit le rapport --explain (explain-*.md) en priorité
  //   summary/explain → lit le rapport run.pl   (compliance-report-*.md)
  let sbPath;
  try { sbPath = path.join(chorus.SANDBOXES_DIR(), sbId); }
  catch (e) { return sseError(res, e.message); }

  // Convention réelle : reports/ est "flat" — on filtre par sous-chaîne
  // projId pour ne garder que les rapports de ce projet (cf. chorus.js
  // § scanFlatProject).
  const repDir = path.join(sbPath, 'workspace', entityId, 'reports');
  let reportContent = null;
  let reportFile    = null;

  // Fichier source demandé (optionnel, ex: ?input=explain-foo-20260928.md)
  const inputFile = req.query.input || null;

  try {
    const allFiles = fs.readdirSync(repDir).filter(f => f.includes(projId)).sort();
    if (action === 'complete-report') {
      // Préférence : fichier explicitement passé, sinon dernier explain-*.md
      const explainFiles = allFiles.filter(f => f.startsWith('explain-') && f.endsWith('.md'));
      reportFile = inputFile && explainFiles.includes(inputFile)
        ? inputFile
        : explainFiles.pop();
      if (reportFile) {
        reportContent = fs.readFileSync(path.join(repDir, reportFile), 'utf8');
      }
      if (!reportContent) {
        // Fallback sur rapport de conformité brut
        const runFiles = allFiles.filter(f =>
          (f.startsWith('compliance-report-') || f.startsWith('pipeline-out-')) && f.endsWith('.md'));
        reportFile = runFiles.pop();
        if (reportFile) reportContent = fs.readFileSync(path.join(repDir, reportFile), 'utf8');
      }
    } else {
      const runFiles = allFiles.filter(f =>
        (f.startsWith('compliance-report-') || f.startsWith('pipeline-out-')) && f.endsWith('.md'));
      reportFile = runFiles.pop();
      if (reportFile) {
        reportContent = fs.readFileSync(path.join(repDir, reportFile), 'utf8');
      }
    }
  } catch {}

  if (!reportContent) {
    const hint = action === 'complete-report'
      ? `Aucun rapport --explain trouvé pour ${projId} — lancez chorus-check --explain d'abord`
      : `Aucun rapport de conformité trouvé pour ${projId} — lancez run.pl d'abord`;
    return sseError(res, hint);
  }

  const systemPrompt = action === 'summary'
    ? prompts.PROMPT_SUMMARY
    : action === 'explain'
    ? prompts.PROMPT_EXPLAIN
    : prompts.PROMPT_COMPLETE_REPORT;
  const outputLabel  = action === 'summary' ? 'summary'
    : action === 'explain' ? 'explain'
    : 'complete-report';

  sseSend(res, 'log', { line: `→ chorus-${action === 'complete-report' ? 'complete-report' : `check --${action}`} (source: ${reportFile || '?'}, LLM: ${MODEL})` });

  // Stream LLM
  let fullText = '';
  try {
    const stream = await client.messages.stream({
      model:      MODEL,
      max_tokens: 3000,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: reportContent }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text;
        fullText += text;
        sseSend(res, 'chunk', { text });
      }
    }

    // Sauvegarder le rapport chorus-check (dans reports/)
    const filename = chorus.writeCheckReport(sbId, entityId, projId, outputLabel, fullText);
    sseSend(res, 'log', { line: `✓ Rapport sauvegardé : ${filename}` });
    sseDone(res, { filename, action });

  } catch (err) {
    sseError(res, `Erreur LLM : ${err.message}`);
  }
});

// ═════════════════════════════════════════════════════════════
// ROUTE 5 — POST /api/sandboxes/:sbId/entities/:entityId/projects/:projId/chat
//
// Session ECA interactive : questions libres sur le rapport
//
// Body JSON :
//   { message: string, history: [{role,content}] }
//
// Réponse JSON (non-streaming pour simplicité) :
//   { ok: true, reply: string }
//
// Pour activer le streaming : changer en SSE comme /check
// ═════════════════════════════════════════════════════════════

app.post('/api/sandboxes/:sbId/entities/:entityId/projects/:projId/chat', async (req, res) => {
  const { sbId, entityId, projId } = req.params;
  const { message, history = [] } = req.body;

  if (!message) return res.status(400).json({ ok: false, error: 'message manquant' });

  // Charger le contexte : rapport brut + éventuels rapports chorus-check
  // (reports/ est "flat" — on filtre par sous-chaîne projId)
  let context = '';
  try {
    const sbPath = path.join(chorus.SANDBOXES_DIR(), sbId);
    const repDir = path.join(sbPath, 'workspace', entityId, 'reports');
    const files  = fs.readdirSync(repDir).filter(f => f.includes(projId) && f.endsWith('.md')).sort();

    for (const f of files) {
      const content = fs.readFileSync(path.join(repDir, f), 'utf8');
      context += `\n\n---\n## ${f}\n\n${content}`;
      if (context.length > 40000) break; // limite de contexte raisonnable
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }

  // Construire l'historique de messages
  const messages = [];

  // Injecter le contexte comme premier message assistant (méthode "context injection")
  if (context) {
    messages.push({ role: 'user',      content: `Voici les rapports Chorus pour ce projet :\n${context}` });
    messages.push({ role: 'assistant', content: 'Compris. Je suis prêt à répondre à vos questions sur ces rapports.' });
  }

  // Ajouter l'historique de la session
  for (const turn of history) {
    if (turn.role && turn.content) messages.push(turn);
  }

  // Ajouter le message courant
  messages.push({ role: 'user', content: message });

  try {
    const resp = await client.messages.create({
      model:      MODEL,
      max_tokens: 1500,
      system:     prompts.PROMPT_CHAT,
      messages,
    });

    const reply = resp.content[0]?.text || '';
    res.json({ ok: true, reply });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Lecture d'un rapport (brut ou chorus-check) ───────────────

app.get('/api/sandboxes/:sbId/entities/:entityId/projects/:projId/reports/:filename', (req, res) => {
  const { sbId, entityId, projId, filename } = req.params;

  // Sécurité : nom de fichier simple uniquement
  if (!/^[\w\-\.]+\.md$/.test(filename)) {
    return res.status(400).json({ ok: false, error: 'Nom de fichier invalide' });
  }

  try {
    const content = chorus.readReport(sbId, entityId, projId, filename);
    if (!content) return res.status(404).json({ ok: false, error: 'Rapport introuvable' });
    res.type('text/markdown').send(content);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Servir le frontend ────────────────────────────────────────

const HTML_FILE = path.join(__dirname, 'chorus-web.html');

app.get('/', (req, res) => {
  if (fs.existsSync(HTML_FILE)) {
    // Désactive le cache navigateur sur la page principale : évite de servir
    // une version obsolète après chaque rebuild en dev (ETag/Last-Modified
    // suffisaient en théorie, mais certains navigateurs/proxys s'y fient
    // trop agressivement en réutilisation silencieuse).
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

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(`  ⚠  ANTHROPIC_API_KEY non définie — /check et /chat ne fonctionneront pas`);
  }

  console.log(`  Modèle LLM  : ${MODEL}\n`);
});
