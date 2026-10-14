/**
 * chorus/reports.js — Compliance reports et run-report index
 *
 * - parseReport       : parse compliance-report-*.md (verdict, scores, lignes)
 * - indexRunReportsDir : indexe run-report-*.json d'un répertoire
 * - buildRunReportIndex : construit l'index complet d'un sandbox (legacy + actuel)
 * - readReport        : lecture sécurisée d'un rapport (flat + nested fallback)
 * - writeCheckReport  : écriture d'un rapport chorus-check
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { SANDBOXES_DIR, readFileSafe, listDirs } = require('./fs');

// ── parseReport ───────────────────────────────────────────────────────────
//
// Format produit par run.pl :
//   # Rapport de conformité — projet-abc
//   Date : 2026-09-28   Norme : ISO 27001:2022
//   Verdict : SOLVED
//   Exigences : 24   CONFORMES : 22   NON_CONFORMES : 1   À confirmer : 1
//   ...
//   | R07 | Sécurité dans la gestion de projet | NON_CONFORME | 28% | ... |

function parseReport(content) {
  const result = {
    verdict:      null,
    totalFrames:  0,
    conformes:    0,
    nonConformes: 0,
    aConfirmer:   0,
    avgConf:      null,
    norm:         null,
    date:         null,
    rows:         [],
  };

  if (!content) return result;

  const mVerdict = content.match(/\bverdict\s*[:\-]\s*(SOLVED|FAILED)/i);
  if (mVerdict) result.verdict = mVerdict[1].toUpperCase();

  const mNorm = content.match(/norme\s*[:\-]\s*([^\n\r]+)/i);
  if (mNorm) result.norm = mNorm[1].trim();

  const mDate = content.match(/date\s*[:\-]\s*(\d{4}-\d{2}-\d{2})/i);
  if (mDate) result.date = mDate[1];

  const mTotal = content.match(/exigences?\s*[:\-]\s*(\d+)/i);
  if (mTotal) result.totalFrames = parseInt(mTotal[1]);

  const mConf = content.match(/conformes?\s*[:\-]\s*(\d+)/i);
  if (mConf) result.conformes = parseInt(mConf[1]);

  const mNonConf = content.match(/non[_\s]conformes?\s*[:\-]\s*(\d+)/i);
  if (mNonConf) result.nonConformes = parseInt(mNonConf[1]);

  const mPend = content.match(/[àa]\s+confirmer\s*[:\-]\s*(\d+)/i);
  if (mPend) result.aConfirmer = parseInt(mPend[1]);

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

  if (result.rows.length) {
    result.avgConf = Math.round(
      result.rows.reduce((s, r) => s + r.conf, 0) / result.rows.length
    );
  }

  return result;
}

// ── Index des run-report-*.json ────────────────────────────────────────────
//
// run.pl écrit reports/run-report-<timestamp>.json. Le lien au projet est
// le champ interne `project_file` (chemin absolu vers workspace/<entity>/<slug>.json).
// On scanne les deux emplacements possibles :
//   - <sandbox>/reports/                      (ancienne convention)
//   - workspace/<entity>/reports/             (convention actuelle)

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
      const key = path.basename(json.project_file);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ file: f, dir, data: json });
    } catch { /* fichier corrompu — ignoré */ }
  }
}

function buildRunReportIndex(sbPath) {
  const index = new Map();
  indexRunReportsDir(path.join(sbPath, 'reports'), index);
  const workspacePath = path.join(sbPath, 'workspace');
  for (const entityId of listDirs(workspacePath)) {
    indexRunReportsDir(path.join(workspacePath, entityId, 'reports'), index);
  }
  return index;
}

// ── Convergence calculée depuis un run-report (fallback sans --all) ───────
//
// `chorus-check <sandbox> <fichier>` (mode single-file, sans --all) calcule
// et affiche déjà un verdict de convergence (discordances attendu/obtenu) en
// Phase 6.2 — mais ne le persiste nulle part : seul le mode --all écrit
// `.last-check-results.json` (Phase 6-all.6). Résultat : l'onglet "Tests" de
// la webapp affichait "Convergence inconnue" après un simple run single-file,
// alors que toute l'information nécessaire est déjà dans le run-report produit
// par CE run — chaque élément y porte son `id` (convention -OK-/-KO-) et son
// `verdict` réel (cf. Engine/agent/skills/chorus-check.md § Phase 6.1, règle
// d'extraction de l'attendu : "-OK-"/"-ok-" → CONFORME attendu, "-KO-"/"-ko-"
// → NON_CONFORME attendu). Cette fonction réapplique la même convention
// directement sur `run-report-*.json`, sans dépendre de --all ni d'aucun
// fichier supplémentaire — un run-report (single-file ou --all) suffit.
//
// Ne remplace PAS .last-check-results.json quand il existe pour ce fichier :
// ce dernier reste la source préférée (calculé par l'agent ECA, avec le
// detail complet des discordances incluant le rule_id responsable via
// _rule_trace — information non reconstructible depuis ce seul fichier JSON
// côté webapp). Ce fallback comble uniquement le cas où .last-check-results.json
// est absent ou ne couvre pas ce fichier projet précis.
function computeConvergenceFromRunReport(reportData) {
  if (!reportData || !Array.isArray(reportData.elements)) return null;

  let discordances = 0;
  let unprocessed   = 0;
  const discDetail   = [];
  const unprocDetail = [];

  for (const e of reportData.elements) {
    const id = e.id || '';
    const verdict = e.verdict || '(unprocessed)';

    if (verdict === '(unprocessed)' || !verdict) {
      unprocessed++;
      unprocDetail.push({ id, type: e.type_element || null });
      continue;
    }

    // NOT_CHECKED — statut métier distinct de CONFORME/NON_CONFORME/(unprocessed),
    // utilisé par certaines règles pour un élément volontairement hors
    // échantillon/périmètre vérifiable (cf. sandbox 05a-CC-3.1.4,
    // operation_mandate_ok: élément hors mandatory_operations() catalogue).
    // Ni une discordance (le moteur n'a jamais tenté CONFORME/NON_CONFORME,
    // donc rien à comparer à l'attendu -OK-/-KO-), ni un "unprocessed"
    // (le moteur l'a bien traité, juste avec ce statut terminal spécifique)
    // — exclu du calcul plutôt que mal classé dans l'une des deux catégories.
    if (verdict === 'NOT_CHECKED') continue;

    let expected = null;
    if (/-OK-/i.test(id))      expected = 'CONFORME';
    else if (/-KO-/i.test(id)) expected = 'NON_CONFORME';
    if (!expected) continue; // id sans convention -OK-/-KO- → pas de discordance calculable

    if (expected !== verdict) {
      discordances++;
      discDetail.push({ id, expected, got: verdict });
    }
  }

  return {
    converged:    reportData.pipeline_solved === true && discordances === 0 && unprocessed === 0,
    discordances,
    unprocessed,
    discDetail,
    unprocDetail,
  };
}

// ── Lecture / écriture de rapports ────────────────────────────────────────

function readReport(sbId, entityId, projId, filename) {
  const entityPath = path.join(SANDBOXES_DIR(), sbId, 'workspace', entityId);
  const flat = readFileSafe(path.join(entityPath, 'reports', filename));
  if (flat !== null) return flat;
  return readFileSafe(path.join(entityPath, 'reports', projId, filename));
}

function writeCheckReport(sbId, entityId, projId, action, content) {
  const repDir = path.join(SANDBOXES_DIR(), sbId, 'workspace', entityId, 'reports');
  fs.mkdirSync(repDir, { recursive: true });
  const ts       = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filename = `${action}-${projId}-${ts}.md`;
  fs.writeFileSync(path.join(repDir, filename), content, 'utf8');
  return filename;
}

module.exports = {
  parseReport,
  indexRunReportsDir,
  buildRunReportIndex,
  computeConvergenceFromRunReport,
  readReport,
  writeCheckReport,
};
