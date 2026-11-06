/**
 * chorus/parser.js — Parseurs org-mode, README et import-report
 *
 * - Parsing import-report-*.org (historique multi-imports)
 * - Parsing org-mode minimal (tables, sections, Frame/Rule catalogue)
 * - Parsing README.org (titre, statut, Coverage, Agent status, Session notes)
 * - Parsing CORPUS-DIRECTIVES.md (version pinning par fichier)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { readFileSafe } = require('./fs');

// Détection "fichier pré-split" — un fichier corpus/NNN-*.md peut être soit
// un document source réel, soit un fichier généré par chorus-corpus-scoping
// Phase 2. README.org § Corpus documente l'origine via la colonne "Source".
const PRESPLIT_SOURCE_RE = /pr[ée]-?split|phase\s*2|agr[ée]g[ée]e?s?/i;

// ── Parsing import-report-*.org ──────────────────────────────────────────
//
// Format produit par chorus-import-project.md (header #+KEY: value + table
// "Résumé" en org-table pipe). Tolérant : les rapports connus n'ont pas
// tous le même jeu de lignes dans leur table Résumé.

function parseImportReportOrg(content) {
  const header = {};
  for (const m of content.matchAll(/^#\+([A-Z_]+):\s*(.+)$/gm)) {
    header[m[1]] = m[2].trim();
  }

  const summary = {};
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/);
    if (!m) continue;
    const [, key, val] = m;
    if (/^-+$/.test(key.replace(/\|/g, ''))) continue;
    summary[key] = val;
  }

  const findSummary = (re) => {
    const k = Object.keys(summary).find(k => re.test(k));
    return k ? summary[k] : null;
  };

  const toInt = (v) => {
    if (v == null) return null;
    const m = String(v).match(/-?\d+/);
    return m ? parseInt(m[0], 10) : null;
  };

  return {
    date:       header.DATE || null,
    source:     header.SOURCE || null,
    output:     header.OUTPUT || header.OUTPUT_JSON || null,
    mode:       header.MODE || null,
    extension:  header.EXTENSION || null,
    frames:     toInt(findSummary(/Éléments produits/i))
              ?? toInt(findSummary(/Alignement direct/i)),
    aConfirmer: toInt(findSummary(/_a_confirmer/i)),
    gaps:       toInt(findSummary(/Gaps/i)),
  };
}

// Historique d'import pour un projet donné (slug) — agrège tous les
// import-report-*.org de reports/ dont #+OUTPUT référence ce slug.

function collectImportHistory(reportsDir, slug) {
  let files = [];
  try {
    files = fs.readdirSync(reportsDir)
      .filter(f => f.startsWith('import-report-') && f.endsWith('.org'))
      .sort();
  } catch { return []; }

  const entries = [];
  for (const f of files) {
    const content = readFileSafe(path.join(reportsDir, f));
    if (!content) continue;
    const parsed = parseImportReportOrg(content);
    if (!parsed.output || !parsed.output.includes(slug)) continue;
    entries.push({
      date:    parsed.date,
      version: parsed.mode,
      frames:  parsed.frames,
      model:   parsed.extension,
      note:    parsed.source ? `Source : ${parsed.source}` : null,
      file:    f,
    });
  }
  return entries;
}

// ── Parsing org-mode minimal ──────────────────────────────────────────────
//
// Pas un parseur org complet — juste ce qu'il faut pour extraire les tables
// pipe et les sections `* Heading` / `** Heading` des fichiers KB générés
// par chorus-feed/chorus-check.

function extractOrgTable(content, headingRegex) {
  const lines = content.split('\n');
  const idx = lines.findIndex(l => headingRegex.test(l.trim()));
  if (idx === -1) return [];
  const rows = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('|')) {
      // A blank line does NOT end the table — org-mode tables are
      // sometimes visually broken by a blank separator line (e.g. left by
      // a manual edit, or by chorus-web's resolveThesaurusPending/
      // unconfirmThesaurusAlias inserting a row without removing a stray
      // blank line) without this being a semantic section break. Only a
      // new heading (`*`/`**` ...) or a genuine non-blank prose line after
      // the table has already started ends it — see incident: sandbox
      // 08b-ANSSI-PG-083-CENTRIC-TEST-01, agent/thesaurus/global.org, a
      // blank line after the "Argon2id" row silently hid every
      // subsequently-added row (including manually-confirmed aliases) from
      // every reader of this table, with no error and no visual sign in
      // the raw file (the blank line looks like harmless formatting).
      if (trimmed === '') continue;
      if (rows.length) break;
      if (/^\*+\s+\S/.test(trimmed)) break;
      continue;
    }
    if (/^\|[-+|]+\|?$/.test(trimmed)) continue;
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
    if (m && m[1].length <= level) break;
    out.push(lines[i]);
  }
  let text = out.join('\n').replace(/^\s*\n+/, '').trim();
  if (maxLen && text.length > maxLen) {
    text = text.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
  }
  return text;
}

// Reconnaît les deux libellés de heading observés dans les agents KB :
//   - "Frame catalogue" / "Frame catalog"  (ancien format heading-style,
//     ex: 03-ETSI, 08-ANSSI-PG-083-CENTRIC — niveau ** ou *)
//   - "Catalogue des Frames"               (format pipe récent, ex:
//     05-CC-3.1.4/agent-adv.org — toujours niveau *)
// Le niveau du heading de section (`*` ou `**`) n'est pas fixe non plus —
// seul compte le fait qu'un heading de niveau <= celui-ci referme la section.
const FRAME_CATALOGUE_HEADING_RE = /^\*+\s+(Frame\s+catalog(ue)?|Catalogue\s+des\s+Frames)\s*$/i;

function extractFrameCatalogue(content) {
  const lines = content.split('\n');
  const startIdx = lines.findIndex(l => FRAME_CATALOGUE_HEADING_RE.test(l.trim()));
  if (startIdx === -1) return [];
  const sectionLevel = (lines[startIdx].match(/^\*+/) || ['*'])[0].length;
  const frames = [];
  let current = null;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.trim().match(/^(\*+)\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      if (level <= sectionLevel) break;  // fin de la section Frame catalogue
      const name = headingMatch[2].trim();
      if (/^type_element\s*[=~]/i.test(name)) continue;  // sous-heading de variante, pas un nouveau Frame
      // Un nouveau Frame démarre à tout heading de niveau sectionLevel+1
      // (`**` si section en `*`, `***` si section en `**`) qui n'est pas
      // une variante `type_element = ...` / `type_element =~ ...`.
      if (level === sectionLevel + 1) {
        current = { name, inputs: [], computed: [], optional: [] };
        frames.push(current);
      }
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

  // ── Format A — "** Rule: <id>" heading style (older agents, e.g. 03-ETSI) ──
  const headingRules = [];
  {
    let current = null;
    let inIntent = false;
    const fieldRe = /^\s*(CHERCHER|FIND|CONDITION|EXCEPTION|ACTION|EFFET|Notes|Signature|Description|Called by|Exported)\s*:/i;
    let startLine = null;
    lines.forEach((line, idx) => {
      const h = line.match(/^\*\*\s+Rule:\s*(.+)/i);
      if (h) {
        if (current) headingRules.push(current);
        current = { id: h[1].trim(), intent: '', line: idx + 1 };
        inIntent = false;
        return;
      }
      if (!current) return;
      const mIntent = line.match(/^\s*Intent\s*:\s*(.+)/i);
      if (mIntent) { current.intent = mIntent[1].trim(); inIntent = true; return; }
      if (!inIntent) return;
      if (line.trim() === '' || fieldRe.test(line) || /^\*+\s/.test(line.trim())) {
        inIntent = false;
      } else if (/^\s{3,}\S/.test(line)) {
        current.intent += ' ' + line.trim();
      } else {
        inIntent = false;
      }
    });
    if (current) headingRules.push(current);
  }
  if (headingRules.length) return headingRules;

  // ── Format B — "* Rule catalog" pipe table (current convention, e.g.
  //    06-CC-3.1.5: | Rule | Corpus | Purpose |). No per-rule line anchor
  //    available (a table row has no heading of its own to scroll to) —
  //    `line` points at the table heading itself; callers needing a precise
  //    scroll target should search client-side for the rule id's first
  //    occurrence in the raw .org text instead (cf. chorus-web.js
  //    openRuleView()).
  // ────────────────────────────────────────────────────────────────────
  const tableRows = extractOrgTable(content, /^\*\s+Rule\s+catalog(ue)?\b/i);
  if (!tableRows.length) return [];
  const header = tableRows[0].map(h => h.toLowerCase());
  const numCol     = header.findIndex(h => h === '#');
  const idCol      = header.findIndex(h => /^rule$/.test(h));
  const corpusCol  = header.findIndex(h => /^corpus$/.test(h));
  const purposeCol = header.findIndex(h => /^purpose$/.test(h));
  if (idCol === -1) return [];
  const headingLine = lines.findIndex(l => /^\*\s+Rule\s+catalog(ue)?\b/i.test(l.trim()));
  return tableRows.slice(1)
    .filter(r => r[idCol] && r[idCol].trim())
    .map(r => {
      const name = r[idCol].trim();
      const num  = numCol !== -1 ? (r[numCol] || '').trim() : '';
      // Deux conventions co-existent dans les sandboxes réels :
      //  - id composite déjà présent dans la colonne "Rule" (ex: 06-CC-3.1.5
      //    "R01-sar-component-identifier-grammar") → id = name tel quel.
      //  - id séparé entre "#" (R01) et "Rule" (nom sans préfixe, ex:
      //    05-CC-3.1.4 "component-identifier-grammar") → reconstruire le
      //    nom composite, qui est la seule forme garantissant un match
      //    1:1 avec le fichier YAML réel (rules/<slug>/R0N-<nom>.yml —
      //    cf. chorus-web.js ruleYamlFilename()/convention documentée).
      const id = (num && !new RegExp(`^${num}[-_]`, 'i').test(name)) ? `${num}-${name}` : name;
      return {
        id,
        intent:  purposeCol !== -1 ? (r[purposeCol] || '').trim() : '',
        corpus:  corpusCol  !== -1 ? (r[corpusCol]  || '').trim() : '',
        line:    headingLine !== -1 ? headingLine + 1 : null,
      };
    });
}

// ── README.org ────────────────────────────────────────────────────────────
//
// Source d'autorité pour title, status, Coverage, Agent status, Session notes.

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

  // ── * Coverage ────────────────────────────────────────────────────────
  const coverageEntries = [];
  let coverageLastUpdate = null;
  {
    const lines = content.split('\n');
    const covIdx = lines.findIndex(l => /^\*\s+Coverage/i.test(l.trim()));
    if (covIdx !== -1) {
      for (let i = covIdx + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t) continue;
        if (/^\*\*?\s/.test(t)) break;
        coverageLastUpdate = t.replace(/^\s+/, '').slice(0, 120);
        break;
      }
      for (let i = covIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        if (/^\*\s+\S/.test(l) && !/^\*\*/.test(l)) break;
        const m = l.match(/^\*{2}\s+([\u2705\u23ed\u26d4✅⏭⛔])\s+(Integrated|Deferred|Out of scope|Promoted this pass)[^\n]*/i);
        if (!m) continue;
        const statusIcon = m[1];
        const kindLabel  = m[2].toLowerCase();
        const kind       = kindLabel.startsWith('promoted') ? 'promoted'
                          : kindLabel.replace(/\s+/g, '_');
        const rest = l.replace(/^\*{2}\s+[\u2705\u23ed\u26d4✅⏭⛔]\s+(Integrated|Deferred|Out of scope|Promoted this pass)\s*/i, '').trim();
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

        let corpusRef = null;
        const detailRows = [];
        let detailHeaders = null;
        let j = i + 1;
        for (; j < lines.length; j++) {
          const bl = lines[j];
          if (/^\*{2}\s+[\u2705\u23ed\u26d4✅⏭⛔]/.test(bl)) break;
          if (/^\*\s+\S/.test(bl) && !/^\*\*/.test(bl)) break;
          const bt = bl.trim();
          if (!bt) continue;
          if (!corpusRef) {
            const cm = bt.match(/^Corpus\s*:\s*(.+)/i);
            if (cm) { corpusRef = cm[1].trim(); continue; }
          }
          if (!bt.startsWith('|')) continue;
          if (/^\|[-+]+\|?$/.test(bt)) continue;
          const cells = bt.split('|').slice(1, -1).map(c => c.trim());
          if (!detailHeaders) { detailHeaders = cells; continue; }
          detailRows.push(cells);
        }

        coverageEntries.push({
          status: statusIcon, kind, label, detail,
          corpusRef,
          detailHeaders: detailHeaders || null,
          detailRows,
        });
      }
    }
  }

  // ── * Agent status ────────────────────────────────────────────────────
  const agentStatusRows = extractOrgTable(content, /^\*\s+Agent status/i);
  const agentStatusTable = agentStatusRows.slice(1)
    .filter(r => r.length >= 2 && r[0] && !/^[-]+$/.test(r[0]))
    .map(r => ({
      agent:           r[0]?.trim() || '',
      kb:              r[1]?.trim() || '',
      yaml:            r[2]?.trim() || '',
      helpers:         r[3]?.trim() || '',
      enrichissements: r[4]?.trim() || '',
    }));

  // ── * Session notes ───────────────────────────────────────────────────
  let enrichmentCount    = 0;
  let enrichmentLastDate = null;
  let infraBugsFixed     = 0;
  let infraBugsTable     = null;
  let kbGapsFixed        = 0;
  let kbGapsTable        = null;
  let bugsFixed          = 0;   // backward-compat aggregate
  let bugsTable          = null;
  let finalValidation    = null;
  {
    const notesText = extractOrgSection(content, /^\*\s+Session notes/i, 0);
    if (notesText) {
      const enrichHeadings = [...notesText.matchAll(/\*{2}\s+Enrichissements?\s+(B[\d/\s,eté]+)/gi)];
      enrichmentCount = enrichHeadings.reduce((total, m) => {
        const nums = [...(m[1] || '').matchAll(/\d+/g)];
        return total + (nums.length || 1);
      }, 0);
      const dateMatches = [...notesText.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)];
      if (dateMatches.length) {
        const dates = dateMatches.map(m => m[1]).sort();
        enrichmentLastDate = dates[dates.length - 1];
      }
      // ── Helper : extract count + combined table for one bug category ──────
      // re must have one capture group for the numeric count.
      const _buildBugsSection = (re) => {
        const matches = [...notesText.matchAll(re)];
        if (!matches.length) return { count: 0, table: null };
        const count = matches.reduce((s, m) => s + parseInt(m[1]), 0);
        const multi = matches.length > 1;
        let combinedHeaders = null;
        const combinedRows = [];
        matches.forEach((m, idx) => {
          const headingIdx = notesText.indexOf(m[0]);
          const afterHeading = notesText.slice(headingIdx + m[0].length);
          const lines = afterHeading.split('\n');
          const headers = [];
          const rows = [];
          for (const bl of lines) {
            const bt = bl.trim();
            if (/^\*{2}\s+\S/.test(bt)) break;
            if (!bt) { if (rows.length) break; continue; }
            if (!bt.startsWith('|')) continue;
            if (/^\|[-+]+\|?$/.test(bt)) continue;
            const cells = bt.split('|').slice(1, -1).map(c => c.trim());
            if (!headers.length) { headers.push(...cells); continue; }
            rows.push(cells);
          }
          if (rows.length) {
            if (!combinedHeaders) combinedHeaders = multi ? ['Session', ...headers] : headers;
            const dateMatch = m[0].match(/\d{4}-\d{2}-\d{2}/);
            const sessionLabel = dateMatch ? dateMatch[0] : `Session ${idx + 1}`;
            rows.forEach(r => combinedRows.push(multi ? [sessionLabel, ...r] : r));
          }
        });
        const table = combinedRows.length ? { headers: combinedHeaders, rows: combinedRows } : null;
        return { count, table };
      };

      // Type 1 — "bugs bloquants" : YAML/Perl implementation bugs that broke
      //           the pipeline (wrong variable scope, missing branches, etc.)
      //           Documented after chorus-check debugging sessions.
      // "bloquants?" handles "bloquant" (singular) as well.
      const _infraSection = _buildBugsSection(
        /\*{2}\s+🐛\s+(\d+)\s+bugs?\s+bloquants?[^\n]*/gi
      );

      // Type 2 — "bugs résolus" : KB semantic gaps (rules computed a verdict
      //           but never propagated it to the `conforme` slot read by run.pl).
      //           Documented after chorus-strengthen + fix sessions.
      // "résolus?" handles "résolu" (singular, e.g. "1 bug résolu") as well.
      const _kbSection = _buildBugsSection(
        /\*{2}\s+🐛\s+(\d+)\s+bugs?\s+résolus?[^\n]*/gi
      );

      // Assign to the outer-scope let variables (const here would shadow them)
      infraBugsFixed = _infraSection.count;
      infraBugsTable = _infraSection.table;
      kbGapsFixed    = _kbSection.count;
      kbGapsTable    = _kbSection.table;

      // Backward-compat aggregate
      bugsFixed = infraBugsFixed + kbGapsFixed;
      bugsTable = infraBugsFixed && !kbGapsFixed ? infraBugsTable
               : kbGapsFixed  && !infraBugsFixed ? kbGapsTable
               : null; // mixed — callers should use the typed fields instead
      const finalSection = (notesText.match(/\*{2}\s+Résultat final[\s\S]*?(?=\n\s*\*{2}\s|\n\s*\*\s[^*]|$)/) || [])[0] || '';
      const mSolved = finalSection.match(/Pipeline\s*[:\-]\s*(SOLVED|FAILED)\s*(✅|❌)?/i);
      const mConf   = finalSection.match(/Conformes?\s*[:\-]\s*(\d+)\s*\/\s*(\d+)/i);
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
    enrichmentCount, enrichmentLastDate,
    infraBugsFixed, infraBugsTable,   // Type 1 — YAML/Perl implementation bugs
    kbGapsFixed,    kbGapsTable,      // Type 2 — KB semantic gaps (strengthen/fix)
    bugsFixed, bugsTable,             // ← backward-compat aggregate (sum of both)
    finalValidation,
  };
}

// ── CORPUS-DIRECTIVES.md ──────────────────────────────────────────────────
//
// Fichier Markdown généré par chorus-corpus-directives — mapping fichier → version.

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

module.exports = {
  PRESPLIT_SOURCE_RE,
  parseImportReportOrg,
  collectImportHistory,
  extractOrgTable,
  extractOrgSection,
  extractFrameCatalogue,
  extractRuleCatalogue,
  parseSandboxReadme,
  parseCorpusDirectivesVersions,
};
