/**
 * server/routes/projects.js — Import, run.pl, chorus-check, chat, run-report
 *
 *   POST /api/sandboxes/:sbId/entities/:entityId/projects/import
 *   POST /api/sandboxes/:sbId/entities/:entityId/projects/:projId/run
 *   GET  /api/sandboxes/:sbId/entities/:entityId/projects/:projId/check
 *   POST /api/sandboxes/:sbId/entities/:entityId/projects/:projId/chat
 *   GET  /api/sandboxes/:sbId/entities/:entityId/projects/:projId/run-report
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Router } = require('express');
const multer = require('multer');
const chorus  = require('../../chorus');
const prompts = require('../../prompts');
const eca     = require('../../eca-client');
const { sseInit, sseSend, sseDone, sseError } = require('../helpers/sse');
const { spawnPerl } = require('../helpers/perl');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-5';

const upload = multer({
  dest: path.join(require('os').tmpdir(), 'chorus-uploads'),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const router = Router();

// ── POST .../projects/import ──────────────────────────────────────────────
//
// Invocation d'une session ECA headless réelle (skill
// `chorus-import-project`), sur le même modèle que server/routes/terminal.js
// (chat dédié + subscribeEcaEvents + routage agent 'code' + timeout/heartbeat)
// — voir Engine/todo-history/TODO.org § "[#J] WEBAPP". L'ancien appel
// `spawnPerl(['chorus-import-project.pl', ...])` est supprimé : ce script
// n'a jamais existé dans le dépôt (placeholder MVP0 jamais implémenté).
//
// Note sur l'extraction d'un helper commun (TODO.org §3) : le pattern
// chatId + subscribeEcaEvents + setChatAgent + timeout/heartbeat est répliqué
// ici depuis terminal.js plutôt qu'extrait dans un helper partagé — la
// logique terminal.js reste plus riche (ask_user, sous-agents, taskboard,
// garde de concurrence chorus-strengthen, respond/stop/delete multi-tour)
// et une extraction prématurée aurait dû paramétrer tout ce surplus pour un
// seul appelant supplémentaire ne s'en servant pas, ce qui aurait complexifié
// l'ensemble sans bénéfice réel. Le code ci-dessous reste volontairement
// une version simplifiée et autonome, adaptée à un usage one-shot (un
// import = un prompt = une fin de session), à réévaluer si un 3e appelant
// du même pattern apparaît.
router.post(
  '/sandboxes/:sbId/entities/:entityId/projects/import',
  upload.single('file'),
  (req, res) => {
    sseInit(res);
    const { sbId, entityId } = req.params;
    const projId    = req.body.projId || `proj-${Date.now()}`;
    const uploadedFile = req.file;
    const timeoutMinutes = Number(req.body.timeoutMinutes);

    if (!uploadedFile) return sseError(res, 'Fichier manquant');
    if (!entityId)     return sseError(res, 'entityId manquant dans l\'URL');

    let sbPath;
    try { sbPath = path.join(chorus.SANDBOXES_DIR(), sbId); }
    catch (e) { return sseError(res, e.message); }

    const entityPath = path.join(sbPath, 'workspace', entityId);
    const srcDir     = path.join(entityPath, 'sources', projId);
    fs.mkdirSync(srcDir, { recursive: true });

    // Conserver le nom de fichier original (plus lisible dans sources/ et dans
    // les rapports import-report-*.org qui y font référence).
    // Sanitisation minimale : suppression des caractères non sûrs pour un
    // chemin filesystem (garde alphanum, tirets, underscores, points, espaces).
    const safeOrigName = uploadedFile.originalname
      .replace(/[^a-zA-Z0-9._\- ]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 200) || `source${path.extname(uploadedFile.originalname) || '.pdf'}`;
    const destFile = path.join(srcDir, safeOrigName);
    // copyFileSync + unlinkSync plutôt que renameSync : multer écrit les
    // uploads sous os.tmpdir() (souvent un volume/device distinct de
    // SANDBOXES_DIR en environnement Docker — bind-mount vs tmpfs/overlay
    // internes) — fs.rename()/renameSync() échoue en EXDEV ("cross-device
    // link not permitted") dès que source et destination ne sont pas sur
    // le même device, ce qui est systématiquement le cas ici en prod
    // conteneurisée (découvert en testant [#J] en conditions réelles,
    // cf. Engine/todo-history/TODO.org § [#J] WEBAPP). copyFileSync
    // fonctionne across-device (copie physique des octets), unlinkSync
    // nettoie ensuite le fichier temporaire.
    fs.copyFileSync(uploadedFile.path, destFile);
    fs.unlinkSync(uploadedFile.path);

    sseSend(res, 'log', { line: `→ Source : ${uploadedFile.originalname} → workspace/${entityId}/sources/${projId}/source${ext}` });
    sseSend(res, 'log', { line: `→ Lancement chorus-import-project (session ECA headless) …` });

    // Timeout configurable (défaut 15 min — import plus simple qu'une
    // session terminal interactive) — borné 1 min .. 4h par sécurité.
    const DEFAULT_TIMEOUT_MINUTES = 15;
    let timeoutMs = Number.isFinite(timeoutMinutes) && timeoutMinutes >= 1 ? timeoutMinutes : DEFAULT_TIMEOUT_MINUTES;
    if (timeoutMs > 240) timeoutMs = 240;
    timeoutMs = timeoutMs * 60_000;

    const DONE_INSTRUCTION =
      '\n\n[IMPORT PROTOCOL — OBLIGATOIRE] ' +
      'Quand ta réponse est entièrement terminée — JSON projet écrit — ' +
      'tu dois écrire en toute dernière ligne, seule sur sa ligne, le mot exactement : DONE';

    // --context <entityId> : label de scope terminologique (cf.
    // chorus-import-project.md § "Scope derivation") — cohérent avec
    // l'usage actuel de la WEBAPP où entityId identifie le client/contexte
    // de l'entité dans le sandbox. Sans cette option, le skill dériverait
    // le scope depuis le chemin du fichier source, ce qui fonctionnerait
    // aussi (destFile est déjà sous workspace/<entityId>/...), mais le
    // passer explicitement est plus robuste et explicite.
    //
    // --out <entityPath>/project-<projId>.json : force le skill à nommer
    // sa sortie selon la convention "flat" réellement reconnue par
    // chorus.scanEntity (regex stricte `/^(projet|project)[-_].*\.json$/i`,
    // cf. chorus/scanner.js) — un simple `<projId>.json` (sans préfixe
    // `project-`/`projet-`) ne matche PAS cette regex et reste invisible
    // au scan "flat" (confirmé par test réel, cf. Engine/todo-history/
    // TODO.org § [#K] WEBAPP pour le détail complet de l'investigation).
    const outFile = path.join(entityPath, `project-${projId}.json`);
    const message = `chorus-import-project ${sbId} ${destFile} --context ${entityId} --out ${outFile}` + DONE_INSTRUCTION;

    const chatId = `eca-import-${sbId}-${projId}`;
    let finished = false;

    const heartbeat = setInterval(() => {
      if (!finished) sseSend(res, 'ping', { t: Date.now() });
    }, 15000);

    const finish = (errMsg) => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      clearTimeout(timeoutHandle);
      if (subReq) { try { subReq.destroy(); } catch {} }
      if (errMsg) return sseError(res, errMsg);
      try {
        // chorus.scanProject est un alias de scanNestedProject (convention
        // legacy sources/<projId>/frames.pl) — totalement sans rapport avec
        // le JSON produit par chorus-import-project (--out ci-dessus, lu par
        // le scan "flat" de scanEntity). L'appeler ici retournerait toujours
        // frames: 0 par construction, quel que soit le nom du fichier JSON
        // (confirmé par test réel, cf. Engine/todo-history/TODO.org §
        // [#K] WEBAPP). Utiliser scanEntity (qui agrège flat + nested) et
        // retrouver le projet par id.
        //
        // ⚠️ scanEntity dérive l'id du projet "flat" depuis le NOM DE
        // FICHIER JSON (slug = nom sans extension, donc ici
        // `project-<projId>`), distinct du `projId` interne utilisé pour
        // le dossier `sources/<projId>/` (qui produit une 2e entrée
        // "nested" vide, state: 'available', sans rapport avec l'import
        // réel) — chercher par `projId` nu matche donc à tort cette entrée
        // nested vide plutôt que l'entrée flat qui contient les vraies
        // données d'import. Chercher explicitement le slug flat en
        // priorité (confirmé par test réel, cf. TODO.org § [#K] WEBAPP).
        const entity = chorus.scanEntity(sbPath, entityId);
        const flatSlug = `project-${projId}`;
        const proj = (entity.projects || []).find(p => p.id === flatSlug)
          || (entity.projects || []).find(p => p.id === projId)
          || { id: projId, state: 'imported', frames: 0 };
        sseSend(res, 'log', { line: `✓ Import terminé — ${proj.frames} frames extraites` });
        sseDone(res, { project: proj });
      } catch {
        sseDone(res, { project: { id: projId, state: 'imported' } });
      }
    };

    const timeoutHandle = setTimeout(
      () => finish(`timeout après ${Math.round(timeoutMs / 60_000)} min — import encore en cours côté ECA`),
      timeoutMs
    );

    // Subscribe AVANT d'envoyer le prompt (même pattern que terminal.js) —
    // évite de manquer les tout premiers événements du chat.
    const { req: sReq, done } = eca.subscribeEcaEvents(chatId, {
      onToolLog: (toolInfo) => { if (!finished) sseSend(res, 'log', { line: `→ ${toolInfo.summary}` }); },
      onDone:    () => finish(),
      onError:   (err) => finish(`ECA events: ${err.message}`),
      // onChunk/onAsk silencieux ici : l'import ne nécessite pas de
      // relayer le texte assistant au front, seuls les logs d'outils et
      // la fin de session comptent pour cette route (cohérent avec
      // l'ancien comportement spawnPerl qui ne relayait que des logs).
    });
    let subReq = sReq;

    // Envoi du prompt, puis routage explicite vers l'agent 'code' — même
    // stratégie anti-race-condition que terminal.js : chat nouveau (jamais
    // vu par eca-server), donc le prompt est envoyé en fire-and-forget,
    // puis on patiente ~200ms (le temps que le chat soit matérialisé
    // côté serveur) avant d'appeler setChatAgent (POST /agent échouerait
    // sur un chatId inconnu si appelé avant la création réelle du chat).
    (async () => {
      const promptPromise = eca.ecaRequest(
        `/api/v1/chats/${encodeURIComponent(chatId)}/prompt`, 'POST', { message }
      );
      await new Promise((r) => setTimeout(r, 200));
      await eca.setChatAgent(chatId, 'code');

      try {
        await promptPromise;
      } catch (err) {
        finish(`Erreur POST prompt : ${err.message}`);
        return;
      }

      await done.catch(() => {});
      finish();
    })().catch((err) => finish(err.message));
  }
);

// ── POST .../projects/:projId/run ─────────────────────────────────────────
router.post('/sandboxes/:sbId/entities/:entityId/projects/:projId/run', (req, res) => {
  sseInit(res);
  const { sbId, entityId, projId } = req.params;

  let sbPath;
  try { sbPath = path.join(chorus.SANDBOXES_DIR(), sbId); }
  catch (e) { return sseError(res, e.message); }

  const entityPath      = path.join(sbPath, 'workspace', entityId);
  const runPl           = path.join(sbPath, 'run.pl');
  const flatProjectFile = path.join(entityPath, `${projId}.json`);
  const legacyFrames    = path.join(entityPath, 'sources', projId, 'frames.pl');

  let inputFile = null;
  if (fs.existsSync(flatProjectFile))    inputFile = flatProjectFile;
  else if (fs.existsSync(legacyFrames)) inputFile = legacyFrames;
  else return sseError(res, `Projet introuvable : ni ${projId}.json ni sources/${projId}/frames.pl`);

  if (!fs.existsSync(runPl)) {
    return sseError(res, `run.pl introuvable à la racine du sandbox — générez-le via chorus-check`);
  }

  sseSend(res, 'log', { line: `→ perl run.pl ${inputFile}` });

  spawnPerl(['run.pl', inputFile], sbPath, res, () => {
    const candidateDirs = [
      path.join(entityPath, 'reports'),
      path.join(sbPath, 'reports'),
    ];

    let reportFile = null, reportDir = null, reportData = null;

    outer:
    for (const dir of candidateDirs) {
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => f.startsWith('run-report-') && f.endsWith('.json')).sort(); }
      catch { continue; }

      for (let i = files.length - 1; i >= 0; i--) {
        try {
          const json = JSON.parse(fs.readFileSync(path.join(dir, files[i]), 'utf8'));
          if (json.project_file !== inputFile) continue;
          reportFile = files[i]; reportDir = dir;
          reportData = {
            verdict:      json.pipeline_solved ? 'SOLVED' : 'FAILED',
            totalFrames:  json.n_total ?? 0,
            conformes:    json.n_conforme ?? 0,
            nonConformes: json.n_non_conforme ?? 0,
            aConfirmer:   json.n_incertain ?? 0,
            norm: null,
            date: (json.generated_at || '').slice(0, 10) || null,
          };
          break outer;
        } catch {}
      }
    }

    if (reportFile) {
      const relDir = path.relative(sbPath, reportDir) || '.';
      sseSend(res, 'log', { line: `✓ Rapport généré : ${relDir}/${reportFile}` });
      sseSend(res, 'log', { line: `  Verdict : ${reportData.verdict} — ${reportData.conformes}/${reportData.totalFrames} CONFORMES` });
    } else {
      sseSend(res, 'log', { line: `⚠ Aucun run-report-*.json trouvé pour project_file=${inputFile}`, level: 'warn' });
    }

    sseDone(res, { reportFile, reportData });
  });
});

// ── GET .../projects/:projId/check ────────────────────────────────────────
router.get('/sandboxes/:sbId/entities/:entityId/projects/:projId/check', async (req, res) => {
  sseInit(res);
  const { sbId, entityId, projId } = req.params;
  const action = (req.query.action || 'summary').toLowerCase();

  if (!['summary', 'explain', 'complete-report'].includes(action)) {
    return sseError(res, `action invalide : ${action} (summary | explain | complete-report)`);
  }

  let sbPath;
  try { sbPath = path.join(chorus.SANDBOXES_DIR(), sbId); }
  catch (e) { return sseError(res, e.message); }

  const repDir    = path.join(sbPath, 'workspace', entityId, 'reports');
  const inputFile = req.query.input || null;
  let reportContent = null, reportFile = null;

  try {
    const allFiles = fs.readdirSync(repDir).filter(f => f.includes(projId)).sort();
    if (action === 'complete-report') {
      const explainFiles = allFiles.filter(f => f.startsWith('explain-') && f.endsWith('.md'));
      reportFile = inputFile && explainFiles.includes(inputFile) ? inputFile : explainFiles.pop();
      if (reportFile) reportContent = fs.readFileSync(path.join(repDir, reportFile), 'utf8');
      if (!reportContent) {
        const runFiles = allFiles.filter(f =>
          (f.startsWith('compliance-report-') || f.startsWith('pipeline-out-')) && f.endsWith('.md'));
        reportFile = runFiles.pop();
        if (reportFile) reportContent = fs.readFileSync(path.join(repDir, reportFile), 'utf8');
      }
    } else {
      const runFiles = allFiles.filter(f =>
        (f.startsWith('compliance-report-') || f.startsWith('pipeline-out-')) && f.endsWith('.md'));
      reportFile = runFiles.pop();
      if (reportFile) reportContent = fs.readFileSync(path.join(repDir, reportFile), 'utf8');
    }
  } catch {}

  if (!reportContent) {
    const hint = action === 'complete-report'
      ? `Aucun rapport --explain trouvé pour ${projId} — lancez chorus-check --explain d'abord`
      : `Aucun rapport de conformité trouvé pour ${projId} — lancez run.pl d'abord`;
    return sseError(res, hint);
  }

  const systemPrompt = action === 'summary' ? prompts.PROMPT_SUMMARY
    : action === 'explain' ? prompts.PROMPT_EXPLAIN
    : prompts.PROMPT_COMPLETE_REPORT;
  const outputLabel = action === 'complete-report' ? 'complete-report' : action;

  sseSend(res, 'log', { line: `→ chorus-check --${action} via eca-server (source: ${reportFile || '?'})` });

  const chatId  = `check-${sbId}-${entityId}-${projId}-${action}-${Date.now()}`;
  const message = `${systemPrompt}\n\n---\n\n${reportContent}`;

  try {
    const { text: fullText } = await eca.promptAndWaitSSE(chatId, message, {
      // onChunk silencieux ici — pas de streaming incrémental vers le client
      // SSE de cette route (le texte est renvoyé en un seul bloc 'chunk' une
      // fois complet, cf. appel sseSend ci-dessous), juste un log de progression.
    });
    sseSend(res, 'log', { line: `… réponse ECA reçue (chat ${chatId})` });
    sseSend(res, 'chunk', { text: fullText });

    const filename = chorus.writeCheckReport(sbId, entityId, projId, outputLabel, fullText);
    sseSend(res, 'log', { line: `✓ Rapport sauvegardé : ${filename}` });
    sseDone(res, { filename, action });
  } catch (err) {
    sseError(res, `Erreur eca-server : ${err.message}`);
  }
});

// ── POST .../projects/:projId/chat ────────────────────────────────────────
router.post('/sandboxes/:sbId/entities/:entityId/projects/:projId/chat', async (req, res) => {
  const { sbId, entityId, projId } = req.params;
  const { message } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: 'message manquant' });

  let context = '';
  try {
    const sbPath = path.join(chorus.SANDBOXES_DIR(), sbId);
    const repDir = path.join(sbPath, 'workspace', entityId, 'reports');
    const files  = fs.readdirSync(repDir).filter(f => f.includes(projId) && f.endsWith('.md')).sort();
    for (const f of files) {
      const content = fs.readFileSync(path.join(repDir, f), 'utf8');
      context += `\n\n---\n## ${f}\n\n${content}`;
      if (context.length > 40000) break;
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }

  const chatId = `chat-${sbId}-${entityId}-${projId}`;
  const fullMessage = context
    ? `${prompts.PROMPT_CHAT}\n\nVoici les rapports Chorus pour ce projet :\n${context}\n\n---\n\nQuestion : ${message}`
    : `${prompts.PROMPT_CHAT}\n\nQuestion : ${message}`;

  try {
    const { text } = await eca.promptAndWaitSSE(chatId, fullMessage, { timeoutMs: 120000 });
    res.json({ ok: true, reply: text });
  } catch (err) {
    res.status(502).json({ ok: false, error: `Erreur eca-server : ${err.message}` });
  }
});

// ── POST .../projects/:projId/audit ──────────────────────────────────────
// Déclenche chorus-audit-import sur le projet JSON importé (mode autonome,
// rapport uniquement — --patch jamais automatique).
// Retourne l'état projet mis à jour (incluant le champ _audit) via scanEntity.
router.post('/sandboxes/:sbId/entities/:entityId/projects/:projId/audit', async (req, res) => {
  sseInit(res);
  const { sbId, entityId, projId } = req.params;
  const withPatch = req.query.patch === '1'; // --patch : explicitment demandé

  let sbPath;
  try { sbPath = path.join(chorus.SANDBOXES_DIR(), sbId); }
  catch (e) { return sseError(res, e.message); }

  const entityPath = path.join(sbPath, 'workspace', entityId);
  const projFile   = path.join(entityPath, `project-${projId}.json`);

  if (!fs.existsSync(projFile)) {
    return sseError(res, `Fichier projet introuvable : workspace/${entityId}/project-${projId}.json`);
  }

  const relProjFile = `workspace/${entityId}/project-${projId}.json`;
  const patchFlag   = withPatch ? ' --patch' : '';

  sseSend(res, 'log', { line: `→ chorus-audit-import ${sbId} ${relProjFile}${patchFlag}` });

  const DONE_INSTRUCTION =
    '\n\n[AUDIT PROTOCOL — OBLIGATOIRE] ' +
    'Quand ta réponse est entièrement terminée — rapport écrit et _audit mis à jour — ' +
    'tu dois écrire en toute dernière ligne, seule sur sa ligne, le mot exactement : DONE';

  const cmd = `chorus-audit-import ${sbId} ${relProjFile}${patchFlag}` + DONE_INSTRUCTION;
  const chatId = `audit-${sbId}-${entityId}-${projId}-${Date.now()}`;

  try {
    const { text } = await eca.promptAndWaitSSE(chatId, cmd, {
      onChunk: chunk => sseSend(res, 'log', { line: chunk }),
      timeoutMs: 10 * 60_000,
    });
    sseSend(res, 'log', { line: '✓ Audit terminé' });

    // Re-scanner le projet pour retourner l'état mis à jour (_audit inclus)
    const entity = chorus.scanEntity(sbPath, entityId);
    const updated = (entity.projects || []).find(p => p.id === `project-${projId}` || p.id === projId);
    sseDone(res, { audit: updated?.audit || null });
  } catch (err) {
    sseError(res, `Erreur audit : ${err.message}`);
  }
});

// ── GET .../projects/:projId/run-report ──────────────────────────────────
router.get('/sandboxes/:sbId/entities/:entityId/projects/:projId/run-report', (req, res) => {
  const { sbId, projId } = req.params;
  let sbPath;
  try { sbPath = path.join(chorus.SANDBOXES_DIR(), sbId); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }

  try {
    const index   = chorus.buildRunReportIndex(sbPath);
    const entries = index.get(`${projId}.json`);
    if (!entries || !entries.length) {
      return res.status(404).json({ ok: false, error: `Aucun run-report trouvé pour ${projId}` });
    }
    const entry = entries[entries.length - 1];
    res.json({ ok: true, file: entry.file, data: entry.data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
