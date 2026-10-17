/**
 * chorus/thesaurus.js — Lecture et résolution du thésaurus sandbox
 *
 * - scanSandboxThesaurus : lecture de tous les shards agent/thesaurus/*.org
 * - resolveThesaurusPending : confirme ou rejette une ligne Pending
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { SANDBOXES_DIR, readFileSafe } = require('./fs');
const { extractOrgTable } = require('./parser');

// ── Scan de tous les shards ────────────────────────────────────────────────

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
      .slice(1).map(r => ({ term: r[0], target: r[1], confidence: r[2], sourceImport: r[3] || null }));
    const aliasesSlotValues = extractOrgTable(content, /^\*\s+Aliases\s*(—|-)\s*slot values/i)
      .slice(1).map(r => ({ term: r[0], slot: r[1], value: r[2], confidence: r[3], sourceImport: r[4] || null }));
    const pending = extractOrgTable(content, /^\*\s+Pending/i)
      .slice(1).map(r => ({
        term: r[0], proposed: r[1], flag: r[2], sourceImport: r[3] || null,
        scope: r[4] ? r[4].trim() : null,  // 5e colonne ajoutée (backward-compat : null → 'global')
      }));
    const outOfScope = extractOrgTable(content, /^\*\s+Out-of-scope/i)
      .slice(1).map(r => ({ term: r[0], reason: r[1] }));

    return { shard, aliasesTypeElement, aliasesSlotValues, pending, outOfScope };
  });
}

// ── Helpers internes pour l'édition org-mode en place ────────────────────

function _findOrgSectionBounds(lines, headingRegex) {
  const idx = lines.findIndex(l => headingRegex.test(l.trim()));
  if (idx === -1) return null;
  const level = (lines[idx].match(/^\*+/) || ['*'])[0].length;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\*+)\s+\S/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return { headingIdx: idx, start: idx + 1, end };
}

function _findTableInsertionPoint(lines, start, end) {
  let headerCells = null;
  let lastRowIdx = null;
  let sawSeparator = false;
  for (let i = start; i < end; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('|')) continue;
    if (/^\|[-+]+\|?$/.test(trimmed)) { sawSeparator = true; continue; }
    if (!headerCells) { headerCells = trimmed.split('|').slice(1, -1).map(c => c.trim()); continue; }
    if (sawSeparator) lastRowIdx = i;
  }
  if (lastRowIdx == null) return null;
  return { lastRowIdx, headerCells };
}

function _makeOrgRow(cells) {
  return `  | ${cells.join(' | ')} |`;
}

// ── Résolution d'une ligne Pending ────────────────────────────────────────
//
// action = 'confirm' | 'reject'
// opts : { typeElement, slot, value } (confirm uniquement)
//
// Backup dans agent/.backups/<shard>.org.bak-<ts> avant toute écriture.

// ── Écriture du journal de décisions terminologiques ─────────────────────
//
// workspace/<entityId>/reports/thesaurus-log-<projectId>.md
// Créé à la première résolution, mis à jour ensuite (ajout d'une ligne).
// Appelé après chaque confirm/reject réussi.

function _appendThesaurusLog(sbPath, entityId, projectId, projectName, entry) {
  if (!entityId || !projectId) return; // pas de contexte projet → skip silencieux
  const reportsDir = path.join(sbPath, 'workspace', entityId, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const logPath = path.join(reportsDir, `thesaurus-log-${projectId}.md`);

  const isNew = !fs.existsSync(logPath);
  const header = isNew
    ? `# Journal de décisions terminologiques\n\n` +
      `**Sandbox** : \`${path.basename(sbPath)}\` &nbsp;·&nbsp; ` +
      `**Projet** : ${projectName || projectId} (\`${projectId}\`)\n\n` +
      `| Date | Terme | Action | type_element | slot | Valeur | Shard | Import source |\n` +
      `|------|-------|--------|--------------|------|--------|-------|---------------|\n`
    : '';

  const row = `| ${entry.date} | \`${entry.term}\` | ${entry.action} | ` +
    `${entry.typeElement || '—'} | ${entry.slot || '—'} | ${entry.value || '—'} | ` +
    `${entry.shard} | ${entry.sourceImport || '—'} |\n`;

  fs.appendFileSync(logPath, header + row, 'utf8');
}

// ── Création d'un shard client vide ──────────────────────────────────────
function _createClientShard(shardPath, sbName, scopeLabel) {
  const header = [
    `#+TITLE: Project terminology thesaurus — sandbox ${sbName} — shard: ${scopeLabel}`,
    `#+UPDATED: ${new Date().toISOString().slice(0, 10)}`,
    `#+DESCRIPTION: Validated project-term → KB-slot mappings for this sandbox, Scope=${scopeLabel}.`,
    `               Maintained automatically by chorus-import-project / chorus-web.`,
    `               Part of a sharded thesaurus — see agent/thesaurus/global.org for Pending/Out-of-scope/Conflicts.`,
    `               Do NOT edit KB org files to add project aliases — use this file instead.`,
    '',
    '* Aliases — type_element',
    `  Project terms validated as mapping to a specific KB type_element, Scope=${scopeLabel}.`,
    '',
    `  | Project term | KB type_element | Confidence | Source import | KB hash @ validation | Scope |`,
    `  |---|---|---|---|---|---|`,
    '',
    '* Aliases — slot values',
    `  Project value expressions validated as mapping to a specific KB slot + value, Scope=${scopeLabel}.`,
    '',
    `  | Project term | KB slot | KB value | Confidence | Source import | KB hash @ validation | Scope |`,
    `  |---|---|---|---|---|---|---|`,
    '',
  ].join('\n');
  fs.writeFileSync(shardPath, header, 'utf8');
}

function resolveThesaurusPending(sbId, shard, term, sourceImport, action, opts = {}) {
  const sbPath   = path.join(SANDBOXES_DIR(), sbId);
  const shardDir = path.join(sbPath, 'agent', 'thesaurus');
  // * Pending vit toujours dans global.org (shard = 'global' in practice).
  const globalPath = path.join(shardDir, `${shard}.org`);
  const content    = readFileSafe(globalPath);
  if (content == null) throw new Error(`Shard thesaurus introuvable : ${shard}.org`);

  const lines = content.split('\n');

  // 1) Localiser la ligne Pending à traiter.
  const pendingBounds = _findOrgSectionBounds(lines, /^\*\s+Pending/i);
  if (!pendingBounds) throw new Error(`Section "Pending" introuvable dans ${shard}.org`);

  let pendingRowIdx = -1;
  let pendingCells = null;
  for (let i = pendingBounds.start; i < pendingBounds.end; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('|') || /^\|[-+]+\|?$/.test(trimmed)) continue;
    const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
    if (cells[0] === 'Project term') continue;
    if (cells[0] === term && cells[3] === sourceImport) {
      pendingRowIdx = i;
      pendingCells = cells;
      break;
    }
  }
  if (pendingRowIdx === -1) {
    throw new Error(`Ligne Pending introuvable pour terme="${term}" source="${sourceImport}" dans ${shard}.org`);
  }

  // 2) Déterminer le Scope cible.
  //    Priorité : colonne 4 de la ligne Pending > opts.scope > 'global'
  const targetScope = (pendingCells[4] && pendingCells[4].trim()) ||
                      (opts.scope && opts.scope.trim()) ||
                      'global';

  // 3) Déterminer le shard cible pour les Aliases confirmés.
  //    Reject → toujours global.org (Out-of-scope est sandbox-wide)
  //    Confirm → shard du Scope cible (peut être différent de global.org)
  const targetShardPath = (action === 'confirm' && targetScope !== 'global')
    ? path.join(shardDir, `${targetScope}.org`)
    : globalPath;
  const targetShardName = (action === 'confirm' && targetScope !== 'global')
    ? targetScope
    : shard;

  // 4) Backup avant écriture (global.org toujours ; target shard si différent).
  const backupDir = path.join(sbPath, 'agent', '.backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  fs.writeFileSync(path.join(backupDir, `${shard}.org.bak-${ts}`), content, 'utf8');
  if (targetShardPath !== globalPath) {
    const targetContent = readFileSafe(targetShardPath);
    if (targetContent) {
      fs.writeFileSync(path.join(backupDir, `${targetShardName}.org.bak-${ts}`), targetContent, 'utf8');
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  // Nettoyage du suffixe legacy "(Scope=xxx)" parfois présent dans le terme.
  const cleanTerm = term.replace(/\s*\(Scope=[^)]+\)\s*$/i, '').trim();

  if (action === 'reject') {
    // Reject → supprimer de Pending + ajouter dans Out-of-scope (les deux dans global.org).
    const outBounds = _findOrgSectionBounds(lines, /^\*\s+Out-of-scope/i);
    if (!outBounds) throw new Error(`Section "Out-of-scope" introuvable dans ${shard}.org`);

    const newRow = _makeOrgRow([cleanTerm, pendingCells[1], '—', sourceImport]);
    lines.splice(pendingRowIdx, 1);

    const outBounds2 = _findOrgSectionBounds(lines, /^\*\s+Out-of-scope/i);
    const insertion2 = _findTableInsertionPoint(lines, outBounds2.start, outBounds2.end);
    if (insertion2) {
      lines.splice(insertion2.lastRowIdx + 1, 0, newRow);
    } else {
      lines.splice(outBounds2.end, 0, newRow);
    }
    fs.writeFileSync(globalPath, lines.join('\n'), 'utf8');

  } else if (action === 'confirm') {
    const typeElement = (opts.typeElement || '').trim();
    if (!typeElement) throw new Error('typeElement requis pour confirmer un alignement type_element');

    const confidence = `✅ confirmed (validated via chorus-web ${today})`;

    // Supprimer la ligne de Pending dans global.org.
    lines.splice(pendingRowIdx, 1);
    fs.writeFileSync(globalPath, lines.join('\n'), 'utf8');

    // Charger (ou créer) le shard cible pour écrire les Aliases.
    if (targetShardPath !== globalPath && !fs.existsSync(targetShardPath)) {
      _createClientShard(targetShardPath, sbId, targetScope);
    }
    const targetContent  = readFileSafe(targetShardPath) || '';
    const targetLines    = targetContent.split('\n');

    // Ajouter dans Aliases — type_element du shard cible.
    const teRow = _makeOrgRow([cleanTerm, typeElement, confidence, sourceImport, '—', targetScope]);
    const teBounds = _findOrgSectionBounds(targetLines, /^\*\s+Aliases\s*(—|-)\s*type_element/i);
    if (!teBounds) throw new Error(`Section "Aliases — type_element" introuvable dans ${targetShardName}.org`);
    const teInsertion = _findTableInsertionPoint(targetLines, teBounds.start, teBounds.end);
    if (teInsertion) {
      targetLines.splice(teInsertion.lastRowIdx + 1, 0, teRow);
    } else {
      targetLines.splice(teBounds.end, 0, teRow);
    }

    // Ajouter dans Aliases — slot values si slot+valeur fournis.
    if (opts.slot && opts.value) {
      const svRow = _makeOrgRow([cleanTerm, opts.slot.trim(), opts.value.trim(), confidence, sourceImport, '—', targetScope]);
      const svBounds = _findOrgSectionBounds(targetLines, /^\*\s+Aliases\s*(—|-)\s*slot values/i);
      if (!svBounds) throw new Error(`Section "Aliases — slot values" introuvable dans ${targetShardName}.org`);
      const svInsertion = _findTableInsertionPoint(targetLines, svBounds.start, svBounds.end);
      if (svInsertion) {
        targetLines.splice(svInsertion.lastRowIdx + 1, 0, svRow);
      } else {
        targetLines.splice(svBounds.end, 0, svRow);
      }
    }

    fs.writeFileSync(targetShardPath, targetLines.join('\n'), 'utf8');

  } else {
    throw new Error(`action invalide : ${action} (attendu "confirm" ou "reject")`);
  }

  // Journal de décisions terminologiques (best-effort — jamais bloquant).
  try {
    const actionLabel = action === 'confirm' ? '✅ Confirmé' : '❌ Rejeté';
    _appendThesaurusLog(sbPath, opts.entityId, opts.projectId, opts.projectName, {
      date:         today,
      term:         cleanTerm,
      action:       actionLabel,
      typeElement:  action === 'confirm' ? (opts.typeElement || '').trim() : null,
      slot:         action === 'confirm' ? (opts.slot  || '').trim() || null : null,
      value:        action === 'confirm' ? (opts.value || '').trim() || null : null,
      shard:        action === 'confirm' ? targetShardName : shard,
      sourceImport,
    });
  } catch { /* ne jamais bloquer la résolution pour le log */ }

  return { ok: true, targetShard: action === 'confirm' ? targetShardName : shard, scope: targetScope };
}

module.exports = { scanSandboxThesaurus, resolveThesaurusPending };
