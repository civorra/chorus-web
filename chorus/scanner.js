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
const { parseReport, buildRunReportIndex } = require('./reports');

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
    sourceFile = imp._source_fichier || imp.source || imp._source
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

  const nestedIds = listDirs(sourcesPath).filter(id => !flatSlugs.has(id));
  const nestedProjects = nestedIds.map(id => scanNestedProject(entityPath, id));

  return { id: entityId, label, path: entityPath, projects: [...flatProjects, ...nestedProjects] };
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

  // Onglet "Tests" — fichiers project-*.json générés par chorus-create-project
  const TESTING_STRATEGIES = {
    iso:   'project-rules-iso.json',
    edges: 'project-edges.json',
    cross: 'project-cross.json',
    scale: 'project-scale.json',
  };
  const testing = {};
  for (const [slug, filename] of Object.entries(TESTING_STRATEGIES)) {
    const exists = fileExists(path.join(sbPath, filename));
    if (!exists) { testing[slug] = null; continue; }
    const entries = runReportIndex.get(filename) || [];
    const latest  = entries[entries.length - 1] || null;
    testing[slug] = {
      file: filename,
      lastRun: latest ? {
        verdict:     latest.data.pipeline_solved ? 'SOLVED' : 'FAILED',
        totalFrames: latest.data.n_total ?? 0,
        conformes:   latest.data.n_conforme ?? 0,
        date:        (latest.data.generated_at || '').slice(0, 10) || null,
      } : null,
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
  scanSandboxCorpus,
  scanFlatProject,
  scanNestedProject,
  scanProject,
  scanEntity,
  scanSandbox,
  scanAll,
};
