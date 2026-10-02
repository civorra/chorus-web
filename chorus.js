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

// ── Scanner un projet — convention RÉELLE des sandboxes Chorus ───
//
//   workspace/<entity>/sources/*             → fichiers source déposés (flat, pas de sous-dossier par projet)
//   workspace/<entity>/<slug>.json           → projet aligné (chorus-import-project), ex. project-import-001.json,
//                                               projet-import-cbom-003-CDX.json — un fichier = un projet, <slug>
//                                               = nom de fichier sans .json
//   workspace/<entity>/reports/*             → rapports (flat), nommés <kind>-<slug>-<seq>.<ext>
//                                               (compliance-report-, pipeline-out-, synthese-, explain-, import-report-)
//
// Un projet est identifié par son <slug> ; ses rapports sont retrouvés par
// correspondance de sous-chaîne sur ce slug dans workspace/<entity>/reports/.

function scanFlatProject(entityPath, slug, jsonFile) {
  const reportsDir = path.join(entityPath, 'reports');
  let reportFiles = [];
  try { reportFiles = fs.readdirSync(reportsDir).filter(f => f.includes(slug)); } catch {}

  const pickLatest = (prefixes, ext) => reportFiles
    .filter(f => prefixes.some(p => f.startsWith(p)) && f.endsWith(ext))
    .sort()
    .pop() || null;

  const reportFile = pickLatest(['compliance-report-', 'pipeline-out-'], '.md');
  const checkReports = reportFiles.filter(f =>
    (f.startsWith('synthese-') || f.startsWith('explain-')) && f.endsWith('.md')
  );

  let reportData = null;
  if (reportFile) {
    reportData = parseReport(readFileSafe(path.join(reportsDir, reportFile)));
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

function scanEntity(sbPath, entityId) {
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
    scanFlatProject(entityPath, slug, path.join(entityPath, `${slug}.json`))
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

  // Entities : 1er niveau de workspace/ — aucun niveau 'default'
  const workspacePath = path.join(sbPath, 'workspace');
  const entityIds     = listDirs(workspacePath);
  const entities      = entityIds.map(eId => scanEntity(sbPath, eId));

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
};
