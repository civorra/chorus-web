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
const eca     = require('./eca-client');

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
// ROUTE 0 — GET /api/eca/health
//
// Ping réel d'eca-server (remplace la pastille de statut simulée côté
// frontend — cf. chorus-web.html § bootServices).
// ═════════════════════════════════════════════════════════════

app.get('/api/eca/health', async (req, res) => {
  const start = Date.now();
  try {
    await eca.ecaRequest('/api/v1/chats', 'GET');
    res.json({ ok: true, latencyMs: Date.now() - start });
  } catch (err) {
    res.json({ ok: false, error: err.message, latencyMs: Date.now() - start });
  }
});

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

// Corpus + modélisation KB d'un sandbox (bouton "📚 Corpus" — pipeline,
// Frame catalogue, Rule catalogue par agent, fichiers corpus réels).
app.get('/api/sandboxes/:sbId/corpus', (req, res) => {
  try {
    const corpus = chorus.scanSandboxCorpus(req.params.sbId);
    res.json({ ok: true, corpus });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Contenu brut de agent/chorus/<slug>.org pour un agent — bouton "👁️ Détails"
// de l'onglet Agents (panneau Corpus).
app.get('/api/sandboxes/:sbId/agents/:slug/org', (req, res) => {
  try {
    const content = chorus.readAgentOrgFile(req.params.sbId, req.params.slug);
    if (!content) return res.status(404).json({ ok: false, error: 'Fichier KB agent introuvable' });
    res.type('text/plain').send(content);
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
// → écrit workspace/<entity>/reports/run-report-<timestamp>.json (JSON
//   structuré, dans le même reports/ que les rapports chorus-import-project
//   / chorus-check). On garde un fallback sur <sandbox>/reports/ pour les
//   run-report générés par une version antérieure de run.pl (écriture à la
//   racine du sandbox via $Bin, avant le fix dirname($fichier)).
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
    // run.pl écrit son rapport JSON dans reports/ SANS identifiant de projet
    // dans le nom de fichier — le seul lien fiable est le champ interne
    // `project_file` (chemin absolu passé en argument à run.pl, ici =
    // inputFile). On ne peut donc PAS se contenter de prendre "le fichier le
    // plus récent du dossier" : si un autre projet vient d'être lancé
    // entre-temps, on retournerait le mauvais rapport.
    //
    // Deux emplacements possibles : workspace/<entity>/reports/ (convention
    // actuelle) et <sandbox>/reports/ (fallback legacy — anciennes versions
    // de run.pl écrivant à la racine via $Bin).
    const candidateDirs = [
      path.join(entityPath, 'reports'),
      path.join(sbPath, 'reports'),
    ];

    let reportFile = null;
    let reportDir  = null;
    let reportData = null;

    outer:
    for (const dir of candidateDirs) {
      let files = [];
      try {
        files = fs.readdirSync(dir)
          .filter(f => f.startsWith('run-report-') && f.endsWith('.json'))
          .sort(); // ordre croissant par timestamp (nom de fichier)
      } catch { continue; }

      // On part de la fin (plus récent en premier) et on garde le premier
      // dont project_file correspond exactement au projet lancé ici.
      for (let i = files.length - 1; i >= 0; i--) {
        const f = files[i];
        try {
          const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (json.project_file !== inputFile) continue;
          reportFile = f;
          reportDir  = dir;
          reportData = {
            verdict:      json.pipeline_solved ? 'SOLVED' : 'FAILED',
            totalFrames:  json.n_total ?? 0,
            conformes:    json.n_conforme ?? 0,
            nonConformes: json.n_non_conforme ?? 0,
            aConfirmer:   json.n_incertain ?? 0,
            norm:         null,
            date:         (json.generated_at || '').slice(0, 10) || null,
          };
          break outer;
        } catch { /* fichier corrompu/illisible — on continue */ }
      }
    }

    if (reportFile) {
      const relDir = path.relative(sbPath, reportDir) || '.';
      sseSend(res, 'log', { line: `✓ Rapport généré : ${relDir}/${reportFile}` });
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

  sseSend(res, 'log', { line: `→ chorus-${action === 'complete-report' ? 'complete-report' : `check --${action}`} via eca-server (source: ${reportFile || '?'})` });

  // Appel au vrai serveur ECA headless (voir eca-client.js) au lieu d'un
  // appel direct au SDK Anthropic — route via un chat ECA dédié à cette
  // requête. Limite connue (MVP) : pas de streaming token-par-token côté
  // navigateur, on poll jusqu'à la fin du traitement puis on envoie le
  // texte complet en un seul "chunk".
  const chatId = `check-${sbId}-${entityId}-${projId}-${action}-${Date.now()}`;
  const message = `${systemPrompt}\n\n---\n\n${reportContent}`;

  try {
    const chat = await eca.promptAndWait(chatId, message, {
      onTick: () => sseSend(res, 'log', { line: `… en attente de la réponse ECA (chat ${chatId})` }),
    });

    if (chat.status === 'error') {
      return sseError(res, `eca-server a renvoyé une erreur pour le chat ${chatId}`);
    }

    const fullText = eca.lastAssistantText(chat);
    sseSend(res, 'chunk', { text: fullText });

    // Sauvegarder le rapport chorus-check (dans reports/)
    const filename = chorus.writeCheckReport(sbId, entityId, projId, outputLabel, fullText);
    sseSend(res, 'log', { line: `✓ Rapport sauvegardé : ${filename}` });
    sseDone(res, { filename, action });

  } catch (err) {
    sseError(res, `Erreur eca-server : ${err.message}`);
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
  const { message } = req.body;
  // Note : `history` n'est plus géré manuellement ici — chaque projet a son
  // propre chat ECA persistant (chatId stable), qui garde l'historique
  // côté eca-server. Le paramètre `history` du body (ancien contrat) est
  // ignoré ; conservé dans la doc d'API pour compat descendante du client.

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

  // chatId stable par projet — persiste l'historique de conversation côté
  // eca-server entre les appels successifs de ce même projet.
  const chatId = `chat-${sbId}-${entityId}-${projId}`;
  const fullMessage = context
    ? `${prompts.PROMPT_CHAT}\n\nVoici les rapports Chorus pour ce projet :\n${context}\n\n---\n\nQuestion : ${message}`
    : `${prompts.PROMPT_CHAT}\n\nQuestion : ${message}`;

  try {
    // First message with AGENTS.md prefix can take longer — use 120s.
  const chat = await eca.promptAndWait(chatId, fullMessage, { timeoutMs: 120000 });
    if (chat.status === 'error') {
      return res.status(502).json({ ok: false, error: `eca-server a renvoyé une erreur pour le chat ${chatId}` });
    }
    res.json({ ok: true, reply: eca.lastAssistantText(chat) });
  } catch (err) {
    res.status(502).json({ ok: false, error: `Erreur eca-server : ${err.message}` });
  }
});

// ═════════════════════════════════════════════════════════════
// ROUTE 5bis — POST /api/sandboxes/:sbId/terminal  (SSE streaming)
//
// Backend du "🖥️ Terminal ECA" générique (niveaux sandbox / entity /
// project / report). Retourne un flux SSE pour une vraie interactivité :
//   - streaming token par token (event: chunk)
//   - ask_user relayé au navigateur   (event: ask)
//   - progression des tool calls      (event: tool)
//   - heartbeat anti-timeout           (event: ping)
//   - fin / erreur                     (event: done / error)
//
// Timeout côté serveur : 10 minutes (skills lourds comme chorus-create-project).
//
// Body JSON : { level, entityId?, projId?, reportFile?, sessionId, message }
// ═════════════════════════════════════════════════════════════

app.post('/api/sandboxes/:sbId/terminal', (req, res) => {
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

    // ── chatId + bootstrap ─────────────────────────────────────────────
    const chatId = `eca-term-${sbId}`;
    let agentsPrefix = '';
    try {
      const list = await eca.ecaRequest('/api/v1/chats', 'GET');
      const isNew = !Array.isArray(list) || !list.find((c) => c.id === chatId);
      if (isNew) {
        const chorusHome = chorus.CHORUS_HOME();
        agentsPrefix =
          `[Chorus ECA Terminal — sandbox: ${sbId}]\n` +
          `Workspace: ${chorusHome}. ` +
          `Engine AGENTS.md: ${path.join(chorusHome, 'Engine', 'AGENTS.md')}. ` +
          `Read it via your tools when needed to answer Chorus commands.\n\n`;
      }
    } catch { /* proceed without prefix */ }

    const fullMessage =
      `${agentsPrefix}[Contexte ECA — niveau ${level}]\n${contextBlock}\n\nQuestion : ${message}`;

    // ── Subscribe to ECA SSE events BEFORE sending the prompt ──────────
    // This ensures no events are missed between POST /prompt and our listener.
    let subReq = null;
    let finished = false;

    const heartbeat = setInterval(() => {
      if (!finished) sseSend(res, 'ping', { t: Date.now() });
    }, 15000);

    const finish = (errMsg) => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      if (subReq) { try { subReq.destroy(); } catch {} }
      if (errMsg) sseError(res, errMsg);
      else sseDone(res, {});
    };

    const timeoutHandle = setTimeout(
      () => finish('timeout après 20 min — skill encore en cours côté ECA (résultat écrit dans le sandbox)'),
      1_200_000
    );

    const { req: sReq, done } = eca.subscribeEcaEvents(chatId, {
      onChunk:   (text) => { if (!finished) sseSend(res, 'chunk', { text }); },
      onAsk:     (payload) => { if (!finished) sseSend(res, 'ask', payload); },
      onToolLog: (summary) => { if (!finished) sseSend(res, 'tool', { summary }); },
      onDone:    () => { clearTimeout(timeoutHandle); finish(); },
      onError:   (err) => { clearTimeout(timeoutHandle); finish(`ECA events: ${err.message}`); },
    });
    subReq = sReq;

    // ── Send the prompt ────────────────────────────────────────────────
    try {
      await eca.ecaRequest(
        `/api/v1/chats/${encodeURIComponent(chatId)}/prompt`, 'POST', { message: fullMessage }
      );
    } catch (err) {
      clearTimeout(timeoutHandle);
      finish(`Erreur POST prompt : ${err.message}`);
      return;
    }

    // Wait for the SSE subscription to resolve (onDone/onError/timeout)
    await done.catch(() => {});
    clearTimeout(timeoutHandle);
    finish();
  })().catch((err) => sseError(res, err.message));
});

// ═════════════════════════════════════════════════════════════
// ROUTE 5ter — POST /api/sandboxes/:sbId/terminal/respond
//
// Soumet la réponse de l'utilisateur à un ask_user d'ECA.
// Body JSON : { message }
// ═════════════════════════════════════════════════════════════

app.post('/api/sandboxes/:sbId/terminal/respond', async (req, res) => {
  const { sbId } = req.params;
  const { message } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: 'message manquant' });
  const chatId = `eca-term-${sbId}`;
  try {
    await eca.ecaRequest(
      `/api/v1/chats/${encodeURIComponent(chatId)}/prompt`, 'POST', { message }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── Lecture du run-report structuré (JSON natif produit par run.pl) ──────
//
// Donne accès aux données réelles par élément (verdict, motif, _rule_trace)
// pour affichage dans la vue de rapport frontend — remplace les données
// simulées (generateMockRows) précédemment utilisées côté client.

app.get('/api/sandboxes/:sbId/entities/:entityId/projects/:projId/run-report', (req, res) => {
  const { sbId, projId } = req.params;
  let sbPath;
  try { sbPath = path.join(chorus.SANDBOXES_DIR(), sbId); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }

  try {
    const index = chorus.buildRunReportIndex(sbPath);
    const entry = index.get(`${projId}.json`);
    if (!entry) {
      return res.status(404).json({ ok: false, error: `Aucun run-report trouvé pour ${projId} — lancez run.pl d'abord` });
    }
    res.json({ ok: true, file: entry.file, data: entry.data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
