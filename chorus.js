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

// Détection "fichier pré-split" — un fichier corpus/NNN-*.md peut être soit un
// document source réel (PDF/Word normatif extrait), soit un fichier généré par
// chorus-corpus-scoping Phase 2 (un extrait mono-agent découpé depuis un
// document source déjà compté par ailleurs). README.org § Corpus documente
// explicitement l'origine de chaque fichier dans sa colonne "Source" — c'est
// la seule source fiable pour distinguer les deux (l'index.org "Integrated
// corpus" ne fait pas cette distinction). On considère qu'un fichier est
// dérivé/pré-split si son texte de provenance correspond à ces motifs.
const PRESPLIT_SOURCE_RE = /pr[ée]-?split|phase\s*2|agr[ée]g[ée]e?s?/i;

// Extensions non-documentaires à ignorer dans le listing corpus (logs d'OCR,
// bytecode Python de scripts d'extraction, etc. — jamais des "éléments du
// corpus" au sens normatif).
const NON_DOC_EXT_RE = /\.(log|pyc|pyo|tmp|bak|swp)$/i;

// Lecture brute de agent/chorus/<slug>.org pour un agent donné — utilisé par
// la vue "Détails" de l'onglet Agents (contenu intégral de la KB, pas
// seulement les sections déjà extraites par extractFrameCatalogue/
// extractRuleCatalogue).
function readAgentOrgFile(sbId, slug) {
  if (!/^[\w-]+$/.test(slug)) return null; // sécurité : nom de slug simple uniquement
  const sbPath = path.join(SANDBOXES_DIR(), sbId);
  return readFileSafe(path.join(sbPath, 'agent', 'chorus', `${slug}.org`));
}

// ── README.org — synthèse structurelle (titre, statut, table Corpus) ──────
//
// README.org (quand présent) contient une table "* Corpus" bien plus riche
// que index.org § Integrated corpus : une colonne "Source" (provenance du
// document, ou mention explicite "Pré-split agent ... (Phase 2)" pour les
// fichiers dérivés) et une colonne "Date" (date du document source). On
// l'utilise comme source d'autorité pour ces deux informations.
function parseSandboxReadme(sbPath) {
  const content = readFileSafe(path.join(sbPath, 'README.org'));
  if (!content) return null;

  const title  = (content.match(/#\+TITLE:\s*(.+)/) || [])[1] || null;
  const date   = (content.match(/#\+DATE:\s*(.+)/) || [])[1] || null;
  const status = (content.match(/#\+STATUS:\s*(.+)/) || [])[1] || null;

  const corpusRows = extractOrgTable(content, /^\*\s+Corpus/i);
  const corpusTable = corpusRows.slice(1)
    .filter(r => r.length >= 3 && /^\d+$/.test(r[0]))
    .map(r => ({
      num:        r[0],
      file:       (r[1] || '').replace(/^corpus\//, ''),
      source:     r[2] || '',
      date:       r[3] || null,
      isPreSplit: PRESPLIT_SOURCE_RE.test(r[2] || ''),
    }));

  // ── * Coverage — synthèse de couverture (pas de LLM) ──────────────────
  // Extrait les headings ** ✅/⏭/⛔ à l'intérieur de la section * Coverage.
  // Format attendu : "** ✅ Integrated — <agent>, <source> (<stats>)"
  //                  "** ⏭ Deferred — <agent> (<detail>)"
  //                  "** ⛔ Out of scope — <agent/source>"
  const coverageEntries = [];
  let coverageLastUpdate = null;
  {
    const lines = content.split('\n');
    const covIdx = lines.findIndex(l => /^\*\s+Coverage/i.test(l.trim()));
    if (covIdx !== -1) {
      // Première ligne non vide après le heading = résumé de dernière MAJ
      for (let i = covIdx + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t) continue;
        if (/^\*\*?\s/.test(t)) break; // premier sous-heading ou heading suivant
        coverageLastUpdate = t.replace(/^\s+/, '').slice(0, 120);
        break;
      }
      // Collecter les headings ** jusqu'à la prochaine section * de niveau 1
      for (let i = covIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        // Fin de section Coverage : heading * de niveau 1 (pas ** ou ***)
        if (/^\*\s+\S/.test(l) && !/^\*\*/.test(l)) break;
        const m = l.match(/^\*{2}\s+([\u2705\u23ed\u26d4✅⏭⛔])\s+(Integrated|Deferred|Out of scope)[^\n]*/i);
        if (!m) continue;
        const statusIcon = m[1];
        const kind       = m[2].toLowerCase().replace(/\s+/g, '_'); // integrated|deferred|out_of_scope
        // Le reste après le kind : "— agent, source (stats)" ou "(stats)"
        const rest = l.replace(/^\*{2}\s+[\u2705\u23ed\u26d4✅⏭⛔]\s+(Integrated|Deferred|Out of scope)\s*/i, '').trim();
        // Extraire agent (après "—"), label court, stats entre parenthèses
        const dashMatch = rest.match(/^—\s*(.+?)(?:\s*\(([^)]+)\))?$/);
        const parenMatch = rest.match(/^\(([^)]+)\)$/);
        let label  = '';
        let detail = '';
        if (dashMatch) {
          label  = dashMatch[1].trim();
          detail = dashMatch[2] || '';
        } else if (parenMatch) {
          detail = parenMatch[1];
        } else {
          label = rest.replace(/\([^)]*\)$/, '').trim();
          detail = (rest.match(/\(([^)]*)\)$/) || [])[1] || '';
        }
        coverageEntries.push({ status: statusIcon, kind, label, detail });
      }
    }
  }

  // ── * Agent status — table KB santé par agent ──────────────────────────
  const agentStatusRows = extractOrgTable(content, /^\*\s+Agent status/i);
  const agentStatusTable = agentStatusRows.slice(1)
    .filter(r => r.length >= 2 && r[0] && !/^[-]+$/.test(r[0]))
    .map(r => ({
      agent:          r[0]?.trim() || '',
      kb:             r[1]?.trim() || '',
      yaml:           r[2]?.trim() || '',
      helpers:        r[3]?.trim() || '',
      enrichissements: r[4]?.trim() || '',
    }));

  // ── * Session notes — enrichissements + bugs + résultat final ─────────
  let enrichmentCount  = 0;
  let enrichmentLastDate = null;
  let bugsFixed        = 0;
  let finalValidation  = null;
  {
    const notesText = extractOrgSection(content, /^\*\s+Session notes/i, 0);
    if (notesText) {
      // Compter les "** Enrichissement B[N]" headings
      const enrichMatches = [...notesText.matchAll(/\*{2}\s+Enrichissement\s+B(\d+)/gi)];
      enrichmentCount = enrichMatches.length;
      // Date du dernier enrichissement — chercher dans les lignes de texte
      const dateMatches = [...notesText.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)];
      if (dateMatches.length) {
        const dates = dateMatches.map(m => m[1]).sort();
        enrichmentLastDate = dates[dates.length - 1];
      }
      // Bugs résolus
      const bugsMatch = notesText.match(/\*{2}\s+🐛\s+(\d+)\s+bugs?\s+bloquants/i);
      if (bugsMatch) bugsFixed = parseInt(bugsMatch[1]);
      // Résultat final
      const finalSection = (notesText.match(/\*{2}\s+Résultat final[\s\S]*?(?=\n\s*\*{2}\s|\n\s*\*\s[^*]|$)/) || [])[0] || '';
      const mSolved   = finalSection.match(/Pipeline\s*[:\-]\s*(SOLVED|FAILED)\s*(✅|❌)?/i);
      const mConf     = finalSection.match(/Conformes?\s*[:\-]\s*(\d+)\s*\/\s*(\d+)/i);
      if (mSolved) {
        finalValidation = {
          solved:    mSolved[1].toUpperCase() === 'SOLVED',
          conformes: mConf ? parseInt(mConf[1]) : null,
          total:     mConf ? parseInt(mConf[2]) : null,
        };
      }
    }
  }

  return {
    title, date, status, corpusTable,
    coverageEntries, coverageLastUpdate,
    agentStatusTable,
    enrichmentCount, enrichmentLastDate, bugsFixed, finalValidation,
  };
}

// ── CORPUS-DIRECTIVES.md — version pinning par fichier ─────────────────────
//
// Fichier Markdown (pas org) généré/maintenu par chorus-corpus-directives —
// contient une table "Sources" avec une colonne "Version pinned" en texte
// libre. Le nom de fichier corpus/*.md est cité entre backticks dans la
// colonne "Source" — on l'extrait par regex pour construire un mapping
// fichier → version, sans dépendre d'un format de table strict.
function parseCorpusDirectivesVersions(sbPath) {
  const content = readFileSafe(path.join(sbPath, 'CORPUS-DIRECTIVES.md'));
  if (!content) return {};
  const versions = {};
  const lines = content.split('\n').filter(l => l.trim().startsWith('|'));
  for (const line of lines) {
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 3) continue;
    const fileMatch = cells[0].match(/`corpus\/([^`]+)`/);
    if (!fileMatch) continue;
    const version = cells[2];
    if (version && !/^-+$/.test(version)) versions[fileMatch[1]] = version;
  }
  return versions;
}

// ── Thésaurus — tous les shards (agent/thesaurus/*.org) ────────────────────
//
// Shardé par Scope (global.org + un fichier par client éventuel, cf.
// chorus-import-project.md § Thesaurus storage layout). Chaque shard
// contient 4 tables fixes : Aliases type_element, Aliases slot values,
// Pending, Out-of-scope.
function scanSandboxThesaurus(sbPath) {
  const thesDir = path.join(sbPath, 'agent', 'thesaurus');
  let files = [];
  try {
    files = fs.readdirSync(thesDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.org'))
      .map(e => e.name);
  } catch { return []; }

  return files.map(fname => {
    const content = readFileSafe(path.join(thesDir, fname));
    const shard = fname.replace(/\.org$/, '');
    if (!content) return { shard, aliasesTypeElement: [], aliasesSlotValues: [], pending: [], outOfScope: [] };

    const aliasesTypeElement = extractOrgTable(content, /^\*\s+Aliases\s*(—|-)\s*type_element/i)
      .slice(1).map(r => ({ term: r[0], target: r[1], confidence: r[2] }));
    const aliasesSlotValues = extractOrgTable(content, /^\*\s+Aliases\s*(—|-)\s*slot values/i)
      .slice(1).map(r => ({ term: r[0], slot: r[1], value: r[2], confidence: r[3] }));
    const pending = extractOrgTable(content, /^\*\s+Pending/i)
      .slice(1).map(r => ({ term: r[0], proposed: r[1], flag: r[2] }));
    const outOfScope = extractOrgTable(content, /^\*\s+Out-of-scope/i)
      .slice(1).map(r => ({ term: r[0], reason: r[1] }));

    return { shard, aliasesTypeElement, aliasesSlotValues, pending, outOfScope };
  });
}

function scanSandboxCorpus(sbId) {
  const sbPath = path.join(SANDBOXES_DIR(), sbId);

  // Fichiers corpus réels sur le filesystem (hors artefacts non-documentaires)
  const corpusDir = path.join(sbPath, 'corpus');
  let corpusFiles = [];
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

  // Enrichissement par fichier : source/date/isPreSplit (README.org) +
  // version (CORPUS-DIRECTIVES.md).
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

  return { title, pipeline, integratedCorpus, corpusFiles, readme, thesaurus };
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
      const key = path.basename(json.project_file);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ file: f, dir, data: json });
    } catch { /* fichier corrompu/illisible — ignoré */ }
  }
}

function buildRunReportIndex(sbPath) {
  const index = new Map(); // basename(project_file) → [{ file, dir, data }, …]  (chronological)

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
  // chorus-check nomme les rapports avec le slug sans préfixe projet-/project-.
  // Ex : projet-import-001-IDNOMIC.json → explain-import-001-IDNOMIC-*.md
  // On accepte les deux formes pour ne pas manquer les rapports liés.
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

  // Priorité 1 : run-report-*.json — source structurée, authoritative,
  // liée explicitement via project_file (racine sandbox en legacy, ou
  // workspace/<entity>/reports/ dans la convention actuelle).
  // All run-reports for this project, sorted chronologically (oldest first).
  // The index value is now an array; the most recent entry drives the displayed
  // verdict/conformity stats, while all entries are exposed as runEntries.
  const runEntries = (runReportIndex && runReportIndex.get(`${slug}.json`)) || [];

  // MVP0 — lier chaque run-report à ses fichiers explain/synthese par timestamp
  // Convention : run-report-YYYYMMDD-HHMMSS.json ↔ {explain,synthese}-<slug>-YYYYMMDD-HHMMSS.md
  for (const entry of runEntries) {
    const ts = (entry.file || '').match(/run-report-(\d{8}-\d{6})\.json/)?.[1];
    entry.explain_file  = ts ? (checkReports.find(f => f.startsWith('explain-')  && f.includes(ts)) ?? null) : null;
    entry.synthese_file = ts ? (checkReports.find(f => f.startsWith('synthese-') && f.includes(ts)) ?? null) : null;
  }

  const runEntry   = runEntries[runEntries.length - 1] || null; // most recent

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
    runEntries,   // all run-reports (array, chronological)
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
  readAgentOrgFile,
};
