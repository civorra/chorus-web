/**
 * chorus.js — Accès au filesystem Chorus
 *
 * Scanne $CHORUS_HOME pour découvrir sandboxes et projets existants.
 * Parse compliance-report-*.md pour extraire l'état et le score.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const CHORUS_HOME = () => {
  const h = process.env.CHORUS_HOME;
  if (!h) throw new Error('CHORUS_HOME non défini dans .env');
  return h;
};

// Répertoire racine des sandboxes — distinct de CHORUS_HOME pour permettre
// de monter tout le dépôt Chorus (y compris Engine/lib pour PERL5LIB) tout
// en pointant précisément vers Engine/sandboxes.
const SANDBOXES_DIR = () => process.env.SANDBOXES || '/chorus/Engine/sandboxes';

// ── Helpers filesystem ────────────────────────────────────────

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function listDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch { return []; }
}

function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

// ── Parsing org-mode minimal (tables, headings) ───────────────
//
// Pas un parseur org complet — juste ce qu'il faut pour extraire les tables
// pipe et les sections `* Heading` / `** Heading` des fichiers KB générés
// par chorus-feed/chorus-check (agent/chorus/index.org et <slug>.org),
// dont le format est strictement conventionnel (cf. chorus-feed.md,
// chorus-engine-yaml.md § Rule Documentation Standard).

function extractOrgTable(content, headingRegex) {
  const lines = content.split('\n');
  const idx = lines.findIndex(l => headingRegex.test(l.trim()));
  if (idx === -1) return [];
  const rows = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('|')) {
      if (rows.length) break;      // table terminée
      if (/^\*+\s+\S/.test(trimmed)) break; // nouvelle section sans table
      continue;
    }
    if (/^\|[-+]+\|?$/.test(trimmed)) continue; // ligne séparatrice |---+---|
    const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
    rows.push(cells);
  }
  return rows;
}

function extractOrgSection(content, headingRegex, maxLen) {
  const lines = content.split('\n');
  const idx = lines.findIndex(l => headingRegex.test(l.trim()));
  if (idx === -1) return '';
  const level = (lines[idx].match(/^\*+/) || ['*'])[0].length;
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\*+)\s+\S/);
    if (m && m[1].length <= level) break; // section de même niveau ou supérieur
    out.push(lines[i]);
  }
  let text = out.join('\n').replace(/^\s*\n+/, '').trim();
  if (maxLen && text.length > maxLen) {
    text = text.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
  }
  return text;
}

function extractFrameCatalogue(content) {
  const lines = content.split('\n');
  const startIdx = lines.findIndex(l => /^\*\*\s+Frame catalogue/i.test(l.trim()));
  if (startIdx === -1) return [];
  const frames = [];
  let current = null;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\*\*\s+\S/.test(line.trim())) break; // fin de section (niveau 2)
    const h3 = line.match(/^\*\*\*\s+(.+)/);
    if (h3) {
      const name = h3[1].trim();
      if (/^type_element\s*=/i.test(name)) continue; // sous-cas, pas une nouvelle Frame
      current = { name, inputs: [], computed: [], optional: [] };
      frames.push(current);
      continue;
    }
    if (!current) continue;
    const mIn = line.match(/Slots d'entrée\s*:\s*(.+)/i);
    if (mIn) current.inputs = mIn[1].replace(/[\[\]]/g, '').split(',').map(s => s.trim()).filter(Boolean);
    const mCalc = line.match(/Slots calculés\s*:\s*(.+)/i);
    if (mCalc) current.computed = mCalc[1].replace(/[\[\]]/g, '').split(',').map(s => s.trim()).filter(Boolean);
    const mOpt = line.match(/Slots optionnels\s*:\s*(.+)/i);
    if (mOpt) current.optional = mOpt[1].replace(/[\[\]]/g, '').split(',').map(s => s.trim()).filter(Boolean);
  }
  return frames;
}

function extractRuleCatalogue(content) {
  const lines = content.split('\n');
  const rules = [];
  let current = null;
  let inIntent = false;
  // Tout champ org connu pouvant suivre "Intent :" dans une entrée de Rule
  // Catalogue — sert à arrêter la concaténation des lignes de continuation
  // avant d'aspirer Signature/Description/Notes/etc. (sections suivantes).
  const fieldRe = /^\s*(CHERCHER|FIND|CONDITION|EXCEPTION|ACTION|EFFET|Notes|Signature|Description|Called by|Exported)\s*:/i;
  for (const line of lines) {
    const h = line.match(/^\*\*\s+Rule:\s*(.+)/i);
    if (h) {
      if (current) rules.push(current);
      current = { id: h[1].trim(), intent: '' };
      inIntent = false;
      continue;
    }
    if (!current) continue;
    const mIntent = line.match(/^\s*Intent\s*:\s*(.+)/i);
    if (mIntent) { current.intent = mIntent[1].trim(); inIntent = true; continue; }
    if (!inIntent) continue;
    if (line.trim() === '' || fieldRe.test(line) || /^\*+\s/.test(line.trim())) {
      inIntent = false;
    } else if (/^\s{3,}\S/.test(line)) {
      current.intent += ' ' + line.trim();
    } else {
      inIntent = false;
    }
  }
  if (current) rules.push(current);
  return rules;
}

// ── Scanner le corpus + sa modélisation KB pour un sandbox ────
//
// Source d'information : agent/chorus/index.org (pipeline + table "Integrated
// corpus" reliant chaque fichier corpus aux agents qui l'exploitent) et
// chaque agent/chorus/<slug>.org (domaine, Frame catalogue, Rule catalogue).
// Complété par un listing réel de corpus/ et un comptage des fichiers YAML
// de rules/<slug>/ (donnée filesystem, toujours à jour même si l'org n'a
// pas encore été relu).

function scanSandboxCorpus(sbId) {
  const sbPath = path.join(SANDBOXES_DIR(), sbId);

  // Fichiers corpus réels sur le filesystem
  const corpusDir = path.join(sbPath, 'corpus');
  let corpusFiles = [];
  try {
    corpusFiles = fs.readdirSync(corpusDir, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        let size = null;
        try { size = fs.statSync(path.join(corpusDir, e.name)).size; } catch {}
        return { name: e.name, size };
      });
  } catch {}

  const indexContent = readFileSafe(path.join(sbPath, 'agent', 'chorus', 'index.org'));
  if (!indexContent) {
    return { title: null, pipeline: [], integratedCorpus: [], corpusFiles };
  }

  const title = (indexContent.match(/#\+TITLE:\s*(.+)/) || [])[1] || sbId;

  const pipelineRows = extractOrgTable(indexContent, /^\*\s+Pipeline global/i);
  const pipeline = pipelineRows.slice(1)
    .filter(r => r.length >= 5 && /^\d+$/.test(r[0]))
    .map(r => ({ pos: r[0], module: r[1], slug: r[2], kb: r[3], status: r[4] }));

  const corpusRows = extractOrgTable(indexContent, /^\*\s+Integrated corpus/i);
  const integratedCorpus = corpusRows.slice(1)
    .filter(r => r.length >= 3)
    .map(r => ({ num: r[0], file: r[1], agents: r[2] }));

  for (const ag of pipeline) {
    const agentContent = readFileSafe(path.join(sbPath, 'agent', 'chorus', `${ag.slug}.org`));
    ag.corpusFile  = null;
    ag.pipelinePos = null;
    ag.domain      = '';
    ag.frames      = [];
    ag.rules       = [];
    ag.ruleFileCount = 0;
    try {
      ag.ruleFileCount = fs.readdirSync(path.join(sbPath, 'rules', ag.slug))
        .filter(f => f.endsWith('.yml')).length;
    } catch {}
    if (agentContent) {
      ag.corpusFile  = (agentContent.match(/#\+CORPUS_FILE:\s*(.+)/) || [])[1] || null;
      ag.pipelinePos = (agentContent.match(/#\+PIPELINE_POS:\s*(.+)/) || [])[1] || null;
      ag.domain      = extractOrgSection(agentContent, /^\*\s+Domain/i, 900);
      ag.frames      = extractFrameCatalogue(agentContent);
      ag.rules       = extractRuleCatalogue(agentContent);
    }
  }

  return { title, pipeline, integratedCorpus, corpusFiles };
}

// ── Parser compliance-report-*.md ────────────────────────────
//
// Format produit par run.pl (exemple) :
//   # Rapport de conformité — projet-abc
//   Date : 2026-09-28   Norme : ISO 27001:2022
//   Verdict : SOLVED
//   Exigences : 24   CONFORMES : 22   NON_CONFORMES : 1   À confirmer : 1
//   ...
//   | R07 | Sécurité dans la gestion de projet | NON_CONFORME | 28% | ... |
//
// On extrait au mieux — si le format varie, on dégrade gracieusement.

function parseReport(content) {
  const result = {
    verdict:      null,   // 'SOLVED' | 'FAILED' | null
    totalFrames:  0,
    conformes:    0,
    nonConformes: 0,
    aConfirmer:   0,
    avgConf:      null,
    norm:         null,
    date:         null,
    rows:         [],     // [{ ref, label, status, conf, source }]
  };

  if (!content) return result;

  // Verdict
  const mVerdict = content.match(/\bverdict\s*[:\-]\s*(SOLVED|FAILED)/i);
  if (mVerdict) result.verdict = mVerdict[1].toUpperCase();

  // Norme
  const mNorm = content.match(/norme\s*[:\-]\s*([^\n\r]+)/i);
  if (mNorm) result.norm = mNorm[1].trim();

  // Date
  const mDate = content.match(/date\s*[:\-]\s*(\d{4}-\d{2}-\d{2})/i);
  if (mDate) result.date = mDate[1];

  // Compteurs (ligne récapitulative ou métadonnées)
  const mTotal = content.match(/exigences?\s*[:\-]\s*(\d+)/i);
  if (mTotal) result.totalFrames = parseInt(mTotal[1]);

  const mConf = content.match(/conformes?\s*[:\-]\s*(\d+)/i);
  if (mConf) result.conformes = parseInt(mConf[1]);

  const mNonConf = content.match(/non[_\s]conformes?\s*[:\-]\s*(\d+)/i);
  if (mNonConf) result.nonConformes = parseInt(mNonConf[1]);

  const mPend = content.match(/[àa]\s+confirmer\s*[:\-]\s*(\d+)/i);
  if (mPend) result.aConfirmer = parseInt(mPend[1]);

  // Lignes de tableau markdown : | REF | Libellé | STATUT | conf% | source |
  const tableRows = [...content.matchAll(
    /\|\s*(R\d+)\s*\|\s*([^|]+)\|\s*(CONFORME|NON_CONFORME|A_CONFIRMER|NON CONFORME|À CONFIRMER)\s*\|\s*(\d+)\s*%?\s*\|\s*([^|]*)\|/gi
  )];
  for (const m of tableRows) {
    const status = m[3].toUpperCase()
      .replace('NON CONFORME', 'NON_CONFORME')
      .replace('À CONFIRMER', 'A_CONFIRMER')
      .replace('A CONFIRMER', 'A_CONFIRMER');
    result.rows.push({
      ref:    m[1].trim(),
      label:  m[2].trim(),
      status,
      conf:   parseInt(m[4]),
      source: m[5].trim() || '—',
    });
  }

  // Confiance moyenne (calculée si pas dans le rapport)
  if (result.rows.length) {
    result.avgConf = Math.round(
      result.rows.reduce((s, r) => s + r.conf, 0) / result.rows.length
    );
  }

  return result;
}

// ── Index des run-report-*.json ────────────────────────────────
//
// run.pl (quand il persiste un rapport — cf. sandboxes CyberSec) écrit
// reports/run-report-<timestamp>.json dans le dossier du projet traité, soit
// workspace/<entity>/reports/ (convention actuelle). Le NOM de fichier ne
// contient aucun identifiant de projet : le seul lien fiable est le champ
// interne `project_file`, qui contient le chemin absolu passé en argument
// à run.pl (= workspace/<entity>/<slug>.json). On indexe donc tous ces
// fichiers une fois par scan de sandbox, par basename(project_file).
//
// On scanne à la fois :
//   - <sandbox>/reports/                      (ancienne convention — avant
//     le patch run.pl qui écrivait à la racine du sandbox via $Bin)
//   - workspace/<entity>/reports/ pour chaque entity (convention actuelle)
// afin de rester compatible avec les rapports déjà générés par d'anciennes
// versions de run.pl sans rien perdre.
//
// Fichiers triés par nom (= par timestamp croissant) avant indexation afin
// que la dernière écriture dans la Map soit toujours la plus récente pour
// un même projet, même en cas de doublon entre les deux emplacements.

function indexRunReportsDir(dir, index) {
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(f => f.startsWith('run-report-') && f.endsWith('.json'))
      .sort();
  } catch { return; }

  for (const f of files) {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!json.project_file) continue;
      index.set(path.basename(json.project_file), { file: f, dir, data: json });
    } catch { /* fichier corrompu/illisible — ignoré */ }
  }
}

function buildRunReportIndex(sbPath) {
  const index = new Map(); // basename(project_file) → { file, data }

  // Legacy : racine du sandbox (anciens run-report-*.json)
  indexRunReportsDir(path.join(sbPath, 'reports'), index);

  // Convention actuelle : workspace/<entity>/reports/ pour chaque entity
  const workspacePath = path.join(sbPath, 'workspace');
  for (const entityId of listDirs(workspacePath)) {
    indexRunReportsDir(path.join(workspacePath, entityId, 'reports'), index);
  }

  return index;
}

// ── Scanner un projet — convention RÉELLE des sandboxes Chorus ───
//
//   workspace/<entity>/sources/*             → fichiers source déposés (flat, pas de sous-dossier par projet)
//   workspace/<entity>/<slug>.json           → projet aligné (chorus-import-project), ex. project-import-001.json,
//                                               projet-import-cbom-003-CDX.json — un fichier = un projet, <slug>
//                                               = nom de fichier sans .json
//   workspace/<entity>/reports/*             → rapports (flat), nommés <kind>-<slug>-<seq>.<ext>
//                                               (compliance-report-, pipeline-out-, synthese-, explain-, import-report-)
//   <sandbox>/reports/run-report-*.json      → rapport de run.pl (sandboxes CyberSec), lié par project_file
//
// Un projet est identifié par son <slug> ; ses rapports texte sont retrouvés
// par correspondance de sous-chaîne sur ce slug dans workspace/<entity>/reports/,
// son éventuel run-report JSON par correspondance exacte du nom de fichier
// <slug>.json dans l'index run-report (cf. buildRunReportIndex ci-dessus).

function scanFlatProject(entityPath, slug, jsonFile, runReportIndex) {
  const reportsDir = path.join(entityPath, 'reports');
  let reportFiles = [];
  try { reportFiles = fs.readdirSync(reportsDir).filter(f => f.includes(slug)); } catch {}

  const pickLatest = (prefixes, ext) => reportFiles
    .filter(f => prefixes.some(p => f.startsWith(p)) && f.endsWith(ext))
    .sort()
    .pop() || null;

  const checkReports = reportFiles.filter(f =>
    (f.startsWith('synthese-') || f.startsWith('explain-')) && f.endsWith('.md')
  );

  // Priorité 1 : run-report-*.json — source structurée, authoritative,
  // liée explicitement via project_file (racine sandbox en legacy, ou
  // workspace/<entity>/reports/ dans la convention actuelle).
  const runEntry = runReportIndex && runReportIndex.get(`${slug}.json`);

  let reportFile = null;
  let reportData = null;

  if (runEntry) {
    const j = runEntry.data;
    // Chemin d'affichage relatif à entityPath si le run-report vit dans
    // workspace/<entity>/reports/, sinon relatif au sandbox (legacy racine).
    reportFile = runEntry.dir === reportsDir
      ? `reports/${runEntry.file}`
      : path.relative(entityPath, path.join(runEntry.dir, runEntry.file));
    reportData = {
      verdict:      j.pipeline_solved ? 'SOLVED' : 'FAILED',
      totalFrames:  j.n_total ?? 0,
      conformes:    j.n_conforme ?? 0,
      nonConformes: j.n_non_conforme ?? 0,
      aConfirmer:   j.n_incertain ?? 0,
      avgConf:      null,
      norm:         null,
      date:         (j.generated_at || '').slice(0, 10) || null,
      rows:         [],
    };
  } else {
    // Priorité 2 (fallback) : compliance-report-/pipeline-out- markdown
    // dans workspace/<entity>/reports/ (autres templates de run.pl).
    const mdFile = pickLatest(['compliance-report-', 'pipeline-out-'], '.md');
    if (mdFile) {
      reportFile = mdFile;
      reportData = parseReport(readFileSafe(path.join(reportsDir, mdFile)));
    }
  }

  const name = slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return {
    id:         slug,
    name,
    sourcePath: jsonFile,
    reportPath: reportsDir,
    state:      'imported',
    frames:     reportData?.totalFrames || 0,
    compliance: reportData ? Math.round(
      ((reportData.conformes || 0) / Math.max(reportData.totalFrames || 1, 1)) * 100
    ) : null,
    verdict:     reportData?.verdict || null,
    reportFile:  reportFile,
    reportData:  reportData,
    checkReports,
    norm:        reportData?.norm || null,
  };
}

// ── Convention alternative (sous-dossier dédié par projet) ───────
//
//   workspace/<entity>/sources/<projId>/   → source(s) + frames.pl (post-import)
//   workspace/<entity>/reports/<projId>/   → compliance-report-*.md, summary-*.md, explain-*.md
//
// Conservée pour compatibilité (sandboxes organisés ainsi), utilisée en
// complément du scan "flat" ci-dessus si aucun fichier <slug>.json n'y
// correspond déjà.

function scanNestedProject(entityPath, projId) {
  const srcDir = path.join(entityPath, 'sources', projId);
  const repDir = path.join(entityPath, 'reports', projId);

  const framesFile = path.join(srcDir, 'frames.pl');
  const reportFiles = fs.existsSync(repDir)
    ? fs.readdirSync(repDir).filter(f => f.startsWith('compliance-report-') && f.endsWith('.md'))
    : [];

  const hasFrames = fileExists(framesFile);
  const hasReport = reportFiles.length > 0;

  let frames = 0;
  if (hasFrames) {
    const content = readFileSafe(framesFile) || '';
    frames = (content.match(/^frame\s*\(/gm) || []).length || 0;
  }

  let reportData = null;
  let reportFile = null;
  if (hasReport) {
    reportFile = reportFiles.sort().pop();
    reportData = parseReport(readFileSafe(path.join(repDir, reportFile)));
  }

  const checkReports = fs.existsSync(repDir)
    ? fs.readdirSync(repDir).filter(f =>
        (f.startsWith('summary-') || f.startsWith('explain-')) && f.endsWith('.md')
      )
    : [];

  const name = projId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return {
    id:         projId,
    name,
    sourcePath: srcDir,
    reportPath: repDir,
    state:      hasFrames ? 'imported' : 'available',
    frames:     reportData?.totalFrames || frames || 0,
    compliance: reportData ? Math.round(
      ((reportData.conformes || 0) / Math.max(reportData.totalFrames || 1, 1)) * 100
    ) : null,
    verdict:     reportData?.verdict || null,
    reportFile:  reportFile || null,
    reportData:  reportData || null,
    checkReports,
    norm:        reportData?.norm || null,
  };
}

// Alias conservé pour compatibilité externe (server.js, scripts)
const scanProject = scanNestedProject;

// ── Scanner une entity (1er niveau de workspace/) ─────────────
//
// Pas de niveau 'default' : chaque sandbox n'expose que les entities
// réellement présentes sous workspace/.

function scanEntity(sbPath, entityId, runReportIndex) {
  const entityPath  = path.join(sbPath, 'workspace', entityId);
  const sourcesPath = path.join(entityPath, 'sources');

  // Libellé optionnel depuis une config dédiée à l'entity
  let label = entityId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const cfgE = readFileSafe(path.join(entityPath, 'config.json'));
  if (cfgE) { try { label = JSON.parse(cfgE).label || label; } catch {} }

  // 1) Convention réelle : fichiers <slug>.json (project*/projet*) à la
  //    racine de l'entity — un fichier = un projet.
  let rootFiles = [];
  try {
    rootFiles = fs.readdirSync(entityPath, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => e.name);
  } catch {}

  const projectJsonFiles = rootFiles.filter(f => /^(projet|project)[-_].*\.json$/i.test(f));
  const flatSlugs = new Set(projectJsonFiles.map(f => f.replace(/\.json$/i, '')));

  const flatProjects = [...flatSlugs].map(slug =>
    scanFlatProject(entityPath, slug, path.join(entityPath, `${slug}.json`), runReportIndex)
  );

  // 2) Convention alternative : sous-dossiers sources/<projId>/ dédiés
  //    (seulement s'ils ne font pas déjà doublon avec un slug détecté ci-dessus).
  const nestedIds = listDirs(sourcesPath).filter(id => !flatSlugs.has(id));
  const nestedProjects = nestedIds.map(id => scanNestedProject(entityPath, id));

  return { id: entityId, label, path: entityPath, projects: [...flatProjects, ...nestedProjects] };
}

// ── Scanner un sandbox ────────────────────────────────────────

function scanSandbox(sbId) {
  const sbPath  = path.join(SANDBOXES_DIR(), sbId);

  // Lire config sandbox (config.pl, config.json, ou heuristique depuis le nom)
  let name     = sbId;
  let norm     = 'ISO 27001:2022';
  let desc     = '';
  let standard = 'ISO 27001:2022';

  const configJson = readFileSafe(path.join(sbPath, 'config.json'));
  if (configJson) {
    try {
      const cfg = JSON.parse(configJson);
      name     = cfg.name     || name;
      norm     = cfg.norm     || norm;
      desc     = cfg.desc     || cfg.description || desc;
      standard = cfg.standard || norm;
    } catch {}
  }

  // Pas de config.json : essayer config.pl (format Perl simple)
  if (!configJson) {
    const configPl = readFileSafe(path.join(sbPath, 'config.pl'));
    if (configPl) {
      const mName = configPl.match(/name\s*=>\s*['"]([^'"]+)['"]/);
      const mNorm = configPl.match(/norm\s*=>\s*['"]([^'"]+)['"]/);
      const mDesc = configPl.match(/desc\s*=>\s*['"]([^'"]+)['"]/);
      if (mName) name = mName[1];
      if (mNorm) { norm = mNorm[1]; standard = mNorm[1]; }
      if (mDesc) desc = mDesc[1];
    }
  }

  // Index des run-report-*.json du sandbox (une seule lecture pour toutes
  // les entities — cf. buildRunReportIndex § lien project_file).
  const runReportIndex = buildRunReportIndex(sbPath);

  // Entities : 1er niveau de workspace/ — aucun niveau 'default'
  const workspacePath = path.join(sbPath, 'workspace');
  const entityIds     = listDirs(workspacePath);
  const entities      = entityIds.map(eId => scanEntity(sbPath, eId, runReportIndex));

  return { id: sbId, name, norm, standard, desc, path: sbPath, entities };
}

// ── Scan global ───────────────────────────────────────────────

function scanAll() {
  const sbIds = listDirs(SANDBOXES_DIR());
  return sbIds.map(scanSandbox);
}

// ── Lecture d'un rapport complet ─────────────────────────────
//
// Convention réelle : reports/ est "flat" (pas de sous-dossier par projet).
// On essaie d'abord ce chemin, puis on retombe sur l'ancienne convention
// imbriquée (reports/<projId>/<filename>) par compatibilité.

function readReport(sbId, entityId, projId, filename) {
  const entityPath = path.join(SANDBOXES_DIR(), sbId, 'workspace', entityId);
  const flat = readFileSafe(path.join(entityPath, 'reports', filename));
  if (flat !== null) return flat;
  return readFileSafe(path.join(entityPath, 'reports', projId, filename));
}

// ── Écriture d'un rapport chorus-check ───────────────────────
//
// Écrit en "flat" dans reports/ (convention réelle), nommé
// <action>-<projId>-<date>.md — le slug <projId> suffit à relier le
// rapport à son projet (cf. scanFlatProject, correspondance par sous-chaîne).

function writeCheckReport(sbId, entityId, projId, action, content) {
  const repDir = path.join(SANDBOXES_DIR(), sbId, 'workspace', entityId, 'reports');
  fs.mkdirSync(repDir, { recursive: true });
  const ts       = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filename = `${action}-${projId}-${ts}.md`;
  fs.writeFileSync(path.join(repDir, filename), content, 'utf8');
  return filename;
}

module.exports = {
  CHORUS_HOME,
  SANDBOXES_DIR,
  scanAll,
  scanSandbox,
  scanEntity,
  scanProject,
  parseReport,
  readReport,
  writeCheckReport,
  buildRunReportIndex,
  scanSandboxCorpus,
};
