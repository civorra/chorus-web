/**
 * chorus/scanner.js — Scanners sandbox, entity, projets et corpus KB
 *
 * - readAgentOrgFile  : lecture brute d'un fichier agent/chorus/<slug>.org
 * - scanSandboxCorpus : pipeline + corpus + agents d'un sandbox
 * - scanFlatProject   : projet convention workspace/<entity>/<slug>.json
 * - scanNestedProject : projet convention workspace/<entity>/sources/<id>/
 * - scanEntity        : toutes les entities d'un workspace
 * - scanSandbox       : un sandbox complet (entities + testing + kbModeled)
 * - scanAll           : tous les sandboxes
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { SANDBOXES_DIR, readFileSafe, listDirs, fileExists } = require('./fs');
const {
  parseSandboxReadme,
  parseCorpusDirectivesVersions,
  extractOrgSection,
  extractFrameCatalogue,
  extractRuleCatalogue,
  collectImportHistory,
} = require('./parser');
const { scanSandboxThesaurus } = require('./thesaurus');
const { parseReport, buildRunReportIndex, computeConvergenceFromRunReport } = require('./reports');

// Extensions non-documentaires à ignorer dans le listing corpus.
const NON_DOC_EXT_RE = /\.(log|pyc|pyo|tmp|bak|swp)$/i;

// ── Lecture brute d'un fichier agent/chorus/<slug>.org ────────────────────

function readAgentOrgFile(sbId, slug) {
  if (!/^[\w-]+$/.test(slug)) return null;
  const sbPath = path.join(SANDBOXES_DIR(), sbId);
  return readFileSafe(path.join(sbPath, 'agent', 'chorus', `${slug}.org`));
}

// ── scanSandboxCorpus ─────────────────────────────────────────────────────
//
// Source : agent/chorus/index.org (pipeline + Integrated corpus) et
// chaque agent/chorus/<slug>.org (domain, Frame/Rule catalogue, yaml count).

function scanSandboxCorpus(sbId) {
  const sbPath = path.join(SANDBOXES_DIR(), sbId);

  let corpusFiles = [];
  const corpusDir = path.join(sbPath, 'corpus');
  try {
    corpusFiles = fs.readdirSync(corpusDir, { withFileTypes: true })
      .filter(e => e.isFile() && !NON_DOC_EXT_RE.test(e.name) && !e.name.startsWith('.'))
      .map(e => {
        let size = null;
        try { size = fs.statSync(path.join(corpusDir, e.name)).size; } catch {}
        return { name: e.name, size };
      });
  } catch {}

  const readme   = parseSandboxReadme(sbPath);
  const versions = parseCorpusDirectivesVersions(sbPath);
  const readmeByFile = {};
  if (readme) readme.corpusTable.forEach(r => { readmeByFile[r.file] = r; });

  corpusFiles = corpusFiles.map(f => {
    const r = readmeByFile[f.name];
    return {
      ...f,
      source:     r ? r.source : null,
      date:       r ? r.date : null,
      isPreSplit: r ? r.isPreSplit : false,
      version:    versions[f.name] || null,
    };
  });

  const thesaurus = scanSandboxThesaurus(sbPath);

  const indexContent = readFileSafe(path.join(sbPath, 'agent', 'chorus', 'index.org'));
  if (!indexContent) {
    return { title: null, pipeline: [], integratedCorpus: [], corpusFiles, readme, thesaurus };
  }

  const title = (indexContent.match(/#\+TITLE:\s*(.+)/) || [])[1] || sbId;

  // Helpers locaux pour extraire les tables de index.org
  const { extractOrgTable } = require('./parser');

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
    ag.corpusFile    = null;
    ag.pipelinePos   = null;
    ag.domain        = '';
    ag.frames        = [];
    ag.rules         = [];
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

  return { title, pipeline, integratedCorpus, corpusFiles, readme, thesaurus };
}

// ── scanFlatProject ───────────────────────────────────────────────────────
//
// Convention réelle : workspace/<entity>/<slug>.json (un fichier = un projet).

function scanFlatProject(entityPath, slug, jsonFile, runReportIndex) {
  const reportsDir = path.join(entityPath, 'reports');
  const reportSlug = slug.replace(/^(projet|project)[-_]/i, '');
  let reportFiles = [];
  try {
    reportFiles = fs.readdirSync(reportsDir).filter(f =>
      f.includes(slug) || (reportSlug !== slug && f.includes(reportSlug))
    );
  } catch {}

  const pickLatest = (prefixes, ext) => reportFiles
    .filter(f => prefixes.some(p => f.startsWith(p)) && f.endsWith(ext))
    .sort()
    .pop() || null;

  const checkReports = reportFiles.filter(f =>
    (f.startsWith('synthese-') || f.startsWith('explain-')) && f.endsWith('.md')
  );

  const runEntries = (runReportIndex && runReportIndex.get(`${slug}.json`)) || [];

  for (const entry of runEntries) {
    const ts = (entry.file || '').match(/run-report-(\d{8}-\d{6})\.json/)?.[1];
    entry.explain_file  = ts ? (checkReports.find(f => f.startsWith('explain-')  && f.includes(ts)) ?? null) : null;
    entry.synthese_file = ts ? (checkReports.find(f => f.startsWith('synthese-') && f.includes(ts)) ?? null) : null;
  }

  const runEntry = runEntries[runEntries.length - 1] || null;

  let reportFile = null;
  let reportData = null;

  if (runEntry) {
    const j = runEntry.data;
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
    const mdFile = pickLatest(['compliance-report-', 'pipeline-out-'], '.md');
    if (mdFile) {
      reportFile = mdFile;
      reportData = parseReport(readFileSafe(path.join(reportsDir, mdFile)));
    }
  }

  const name = slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  let sourceFile = null;
  let imports    = collectImportHistory(reportsDir, slug);
  try {
    const projJson = JSON.parse(readFileSafe(jsonFile) || '{}');
    const imp = projJson._import || {};
    // `source_file` (underscore, no leading `_`) is the key actually and
    // consistently produced by chorus-import-project in every real JSON
    // observed (confirmed across 3 independent imports: the original
    // eviden/projet-import-cbom-001-Cosmian-KMS.json, the test/ import, and
    // a later eviden re-import — all three use `source_file`, none ever
    // used the other candidate keys below). It is tried FIRST; the other
    // candidates are kept only as a defensive fallback for any older/other
    // JSON shape not yet seen. Before this fix, `source_file` was absent
    // from the candidate list entirely, so sourceFile silently resolved to
    // null for every real import — the concrete, observed consequence: the
    // re-import command built from this value (chorus-web.js § startImport
    // reimportId branch) was generated with an EMPTY source argument
    // (`chorus-import-project <sbId>  --context ...`, double space, no
    // path), forcing the ECA agent to guess/reconstruct the source path on
    // its own rather than being told it explicitly — a real incident
    // encountered when re-importing workspace/eviden/projet-import-cbom-001-
    // Cosmian-KMS.json, 2026-10-16.
    sourceFile = imp.source_file || imp._source_fichier || imp.source || imp._source
      || (Array.isArray(imp.sources)  ? imp.sources[0]  : null)
      || (Array.isArray(imp._sources) ? imp._sources[0] : null)
      || null;
    if (!imports.length && imp && Object.keys(imp).length) {
      imports = [{
        date:    imp.import_date || null,
        version: imp.mode || null,
        frames:  imp.total_elements_resolved ?? imp.total_direct ?? null,
        model:   imp.extension_used || null,
        note:    imp.note || imp._duplicate_warning || null,
      }];
    }
  } catch { /* JSON invalide ou _import absent */ }

  const sourceBasename = sourceFile
    ? path.basename(sourceFile).replace(/\.[^.]+$/, '')
    : null;

  return {
    id:          slug,
    name,
    sourcePath:  jsonFile,
    sourceFile,
    sourceBasename,
    reportPath:  reportsDir,
    state:       'imported',
    frames:      reportData?.totalFrames || 0,
    compliance:  reportData ? Math.round(
      ((reportData.conformes || 0) / Math.max(reportData.totalFrames || 1, 1)) * 100
    ) : null,
    verdict:     reportData?.verdict || null,
    reportFile,
    reportData,
    checkReports,
    runEntries,
    imports,
    norm:        reportData?.norm || null,
  };
}

// ── scanNestedProject ─────────────────────────────────────────────────────
//
// Convention alternative : workspace/<entity>/sources/<projId>/.

function scanNestedProject(entityPath, projId) {
  const srcDir = path.join(entityPath, 'sources', projId);
  const repDir = path.join(entityPath, 'reports', projId);

  const framesFile  = path.join(srcDir, 'frames.pl');
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
    verdict:    reportData?.verdict || null,
    reportFile: reportFile || null,
    reportData: reportData || null,
    checkReports,
    norm:       reportData?.norm || null,
  };
}

// Alias rétro-compat (server.js, scripts)
const scanProject = scanNestedProject;

// ── scanEntity ────────────────────────────────────────────────────────────

function scanEntity(sbPath, entityId, runReportIndex) {
  const entityPath  = path.join(sbPath, 'workspace', entityId);
  const sourcesPath = path.join(entityPath, 'sources');

  let label = entityId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const cfgE = readFileSafe(path.join(entityPath, 'config.json'));
  if (cfgE) { try { label = JSON.parse(cfgE).label || label; } catch {} }

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

  // A `sources/<id>/` directory is excluded from the "nested legacy project"
  // scan below not only when `<id>` itself is a flat slug, but also when
  // `project-<id>`/`projet-<id>` is — i.e. when this source folder is simply
  // the upload staging directory of a project that was later written under
  // the "flat" naming convention (cf. server/routes/projects.js § POST
  // .../projects/import: `srcDir = sources/<projId>`, `destFile` is later
  // written as the flat `project-<projId>.json`, never as `<projId>.json`).
  // Without this check, every project imported through the real import
  // route re-appeared as a second, phantom "available (not imported)" entry
  // — its source folder id (`import-<ts>`) never equals the flat slug
  // (`project-import-<ts>`), so a plain `flatSlugs.has(id)` check always
  // missed it. Confirmed in practice: sandbox 08-ANSSI-PG-083-CENTRIC,
  // entity test, project "Import 1792076770305" (2026-10-16).
  const isCoveredByFlatProject = (id) =>
    flatSlugs.has(id) || flatSlugs.has(`project-${id}`) || flatSlugs.has(`projet-${id}`);
  const nestedIds = listDirs(sourcesPath).filter(id => !isCoveredByFlatProject(id));
  const nestedProjects = nestedIds.map(id => scanNestedProject(entityPath, id));

  return { id: entityId, label, path: entityPath, projects: [...flatProjects, ...nestedProjects] };
}

// ── readLastCheckResults ──────────────────────────────────────────────────
//
// Lit $SANDBOX/.last-check-results.json, écrit par `chorus-check --all`
// (cf. Engine/agent/skills/chorus-check.md § 6-all.6 Persist results cache).
// Contient, par fichier projet, le statut réel de convergence au sens
// "CONFORME/NON_CONFORME attendus == obtenus" (discordances), distinct du
// simple statut SOLVED/FAILED (qui ne dit rien sur l'exactitude des verdicts
// individuels — un test `iso` attend volontairement des NON_CONFORME).
//
// Ce fichier est invalidé (supprimé) par `chorus-feed` à chaque run — son
// absence est donc un état normal ("jamais lancé" ou "KB modifiée depuis"),
// pas une erreur. On distingue les deux en comparant `kb_hash` au contenu
// courant de agent/.kb-hash quand les deux existent.
function readLastCheckResults(sbPath) {
  const raw = readFileSafe(path.join(sbPath, '.last-check-results.json'));
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }

  // Normalisation : agent/.kb-hash est au format sha256sum
  // ("<hash>  <chemin>"), où <chemin> peut être un chemin absolu ou relatif
  // selon la machine/sandbox qui a produit le fichier (ex: sandbox cloné ou
  // renommé après coup — le hash stocké dans .last-check-results.json peut
  // alors référencer l'ancien chemin, ex. .../05-CC-3.1.4/... au lieu de
  // .../05b-CC-3.1.4-NEW/...). Seul le hash sha256 (premier token, avant les
  // espaces) est significatif pour détecter une KB réellement modifiée — le
  // chemin qui suit est ignoré afin d'éviter un faux "stale" quand seul le
  // chemin diffère mais que le contenu de la KB est identique (incident
  // observé sur 05b-CC-3.1.4-NEW, 2026-10).
  const normalizeHash = (s) => (s || '').trim().split(/\s+/)[0] || '';
  const currentKbHash = readFileSafe(path.join(sbPath, 'agent', '.kb-hash'));
  const stale = !!(currentKbHash && data.kb_hash && normalizeHash(currentKbHash) !== normalizeHash(data.kb_hash));

  const byFile = {};
  for (const f of (data.files || [])) {
    byFile[f.file] = {
      status:        f.status || null,
      conforme:      f.conforme ?? 0,
      nonConforme:   f.non_conforme ?? 0,
      unprocessed:   f.unprocessed ?? 0,
      discordances:  f.discordances ?? 0,
      discDetail:    f.disc_detail || [],
      unprocDetail:  f.unproc_detail || [],
      converged:     f.status === 'SOLVED' && (f.discordances ?? 0) === 0 && (f.unprocessed ?? 0) === 0,
    };
  }

  return {
    timestamp:  data.timestamp || null,
    kbHash:     data.kb_hash || null,
    converged:  !!data.converged,
    stale,
    byFile,
  };
}

// ── scanSandbox ────────────────────────────────────────────────────────────

function scanSandbox(sbId) {
  const sbPath = path.join(SANDBOXES_DIR(), sbId);

  let name = sbId, norm = '', desc = '', standard = '';

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

  if (!standard) {
    const readme = parseSandboxReadme(sbPath);
    if (readme && readme.corpusTable.length) {
      const sources = [...new Set(
        readme.corpusTable
          .filter(r => !r.isPreSplit && r.source && r.source.trim())
          .map(r => r.source.trim())
      )];
      if (sources.length) standard = sources.join(' · ');
    }
  }

  const runReportIndex = buildRunReportIndex(sbPath);

  const workspacePath = path.join(sbPath, 'workspace');
  const entityIds     = listDirs(workspacePath);
  const entities      = entityIds.map(eId => scanEntity(sbPath, eId, runReportIndex));

  // Onglet "Tests" — fichiers project-*.json générés par chorus-create-project.
  // Nom bilingue : certains sandboxes francophones (ex. corpus CC/ANSSI en
  // français) utilisent le préfixe `projet-` plutôt que `project-` — Chorus
  // supporte nativement le français (YAML RULE/REGLE, cf. AGENTS.md § Language
  // & conventions), donc le scanner doit tolérer les deux plutôt que de
  // forcer une convention anglaise stricte. `project-` reste essayé en
  // premier (défaut historique) ; `projet-` en repli si le fichier anglais
  // est absent du disque.
  const TESTING_STRATEGIES = {
    iso:   ['project-rules-iso.json', 'projet-rules-iso.json'],
    edges: ['project-edges.json',     'projet-edges.json'],
    cross: ['project-cross.json',     'projet-cross.json'],
    scale: ['project-scale.json',     'projet-scale.json'],
  };
  const lastCheckResults = readLastCheckResults(sbPath);
  const testing = {};
  for (const [slug, candidates] of Object.entries(TESTING_STRATEGIES)) {
    const filename = candidates.find(f => fileExists(path.join(sbPath, f)));
    if (!filename) { testing[slug] = null; continue; }
    const entries = runReportIndex.get(filename) || [];
    let latest = entries[entries.length - 1] || null;
    // Date de création/dernière modification du fichier projet lui-même
    // (affichée sous son nom côté UI, distincte de la date du dernier
    // rapport ci-dessous) — calculée une seule fois, réutilisée aussi par
    // l'invalidation par mtime juste en dessous.
    let fileMtime = null;
    try { fileMtime = fs.statSync(path.join(sbPath, filename)).mtime; } catch { /* ignore */ }
    // Invalidation par régénération — un run-report reste indexé par NOM de
    // fichier (ex. "projet-cross.json"), mais si ce fichier a été régénéré
    // depuis (⟲, cf. regenerateTestingStrategy côté frontend) son contenu a
    // changé — le run-report précédent décrit alors un jeu de données qui
    // n'existe plus sur le disque. Sans ce garde-fou, l'onglet Tests
    // affichait "SOLVED · Converge" (données de l'ancien fichier) juste
    // après une régénération, avant toute ré-exécution du test.
    if (latest && fileMtime && fileMtime.getTime() > new Date(latest.data.generated_at).getTime()) {
      latest = null;
    }
    // Convergence réelle (discordances attendu/obtenu == 0) — préférence
    // .last-check-results.json (Phase 6-all.6, calculé par l'agent ECA avec
    // le rule_id responsable via _rule_trace), sinon repli sur un calcul
    // direct depuis le dernier run-report-*.json de CE fichier (couvre le
    // cas --all jamais lancé / invalidé par chorus-feed depuis — voir
    // computeConvergenceFromRunReport dans reports.js).
    // ⚠️ checkEntry (.last-check-results.json) n'est PAS soumis à la même
    // invalidation par mtime ci-dessus : il porte son propre kb_hash comparé
    // à agent/.kb-hash (stale déjà calculé dans readLastCheckResults) — un
    // mécanisme distinct, orthogonal à la régénération d'un fichier projet
    // individuel (qui n'affecte pas forcément la KB elle-même).
    const checkEntry = lastCheckResults && lastCheckResults.byFile[filename] || null;
    const fallbackConvergence = !checkEntry && latest
      ? computeConvergenceFromRunReport(latest.data)
      : null;
    testing[slug] = {
      file: filename,
      // Date+heure de création/dernière modification du fichier projet lui-même
      // (ex. régénéré via ⟲) — affichée sous son nom côté UI, format ISO complet
      // (secondes incluses) pour distinguer plusieurs régénérations le même jour.
      fileDate: fileMtime ? fileMtime.toISOString().slice(0, 19).replace('T', ' ') : null,
      lastRun: latest ? {
        verdict:     latest.data.pipeline_solved ? 'SOLVED' : 'FAILED',
        totalFrames: latest.data.n_total ?? 0,
        conformes:   latest.data.n_conforme ?? 0,
        // Date+heure complète du rapport (plus seulement la date — un
        // sandbox peut accumuler plusieurs runs le même jour, cf. incident
        // 2026-10-14 où 2 runs successifs sur `cross` le même jour ont
        // généré une confusion temporaire côté opérateur, faute d'heure
        // affichée pour les distinguer).
        date:        (latest.data.generated_at || '').replace('T', ' ') || null,
      } : null,
      convergence: checkEntry ? {
        converged:    checkEntry.converged,
        discordances: checkEntry.discordances,
        unprocessed:  checkEntry.unprocessed,
        discDetail:   checkEntry.discDetail,
        unprocDetail: checkEntry.unprocDetail,
        stale:        lastCheckResults.stale,
        source:       'check-all',
        timestamp:    lastCheckResults.timestamp,
      } : (fallbackConvergence && latest) ? {
        ...fallbackConvergence,
        stale:     false,
        source:    'run-report',
        timestamp: latest.data.generated_at || null,
      } : null, // null = ni .last-check-results.json ni run-report exploitable (jamais lancé, ou invalidé par régénération)
    };
  }

  const kbModeled = fileExists(path.join(sbPath, 'agent', 'chorus', 'index.org'));

  return { id: sbId, name, norm, standard, desc, path: sbPath, entities, testing, kbModeled };
}

// ── scanAll ───────────────────────────────────────────────────────────────

function scanAll() {
  const sbIds = listDirs(SANDBOXES_DIR());
  return sbIds.map(scanSandbox);
}

module.exports = {
  readAgentOrgFile,
  readLastCheckResults,
  scanSandboxCorpus,
  scanFlatProject,
  scanNestedProject,
  scanProject,
  scanEntity,
  scanSandbox,
  scanAll,
};
