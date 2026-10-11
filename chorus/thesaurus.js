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
      .slice(1).map(r => ({ term: r[0], proposed: r[1], flag: r[2], sourceImport: r[3] || null }));
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

function resolveThesaurusPending(sbId, shard, term, sourceImport, action, opts = {}) {
  const sbPath   = path.join(SANDBOXES_DIR(), sbId);
  const thesPath = path.join(sbPath, 'agent', 'thesaurus', `${shard}.org`);
  const content  = readFileSafe(thesPath);
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

  // 2) Backup avant écriture.
  const backupDir = path.join(sbPath, 'agent', '.backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  fs.writeFileSync(path.join(backupDir, `${shard}.org.bak-${ts}`), content, 'utf8');

  const today = new Date().toISOString().slice(0, 10);

  // Nettoyage du suffixe legacy "(Scope=xxx)" parfois présent dans le terme.
  const cleanTerm = term.replace(/\s*\(Scope=[^)]+\)\s*$/i, '').trim();

  if (action === 'reject') {
    const outBounds = _findOrgSectionBounds(lines, /^\*\s+Out-of-scope/i);
    if (!outBounds) throw new Error(`Section "Out-of-scope" introuvable dans ${shard}.org`);

    const newRow = _makeOrgRow([cleanTerm, pendingCells[1], '—', sourceImport]);
    lines.splice(pendingRowIdx, 1);

    const outBounds2  = _findOrgSectionBounds(lines, /^\*\s+Out-of-scope/i);
    const insertion2  = _findTableInsertionPoint(lines, outBounds2.start, outBounds2.end);
    if (insertion2) {
      lines.splice(insertion2.lastRowIdx + 1, 0, newRow);
    } else {
      lines.splice(outBounds2.end, 0, newRow);
    }

  } else if (action === 'confirm') {
    const typeElement = (opts.typeElement || '').trim();
    if (!typeElement) throw new Error('typeElement requis pour confirmer un alignement type_element');

    const teBounds = _findOrgSectionBounds(lines, /^\*\s+Aliases\s*(—|-)\s*type_element/i);
    if (!teBounds) throw new Error(`Section "Aliases — type_element" introuvable dans ${shard}.org`);
    const confidence = `✅ confirmed (validated via chorus-web ${today})`;
    const newRow = _makeOrgRow([cleanTerm, typeElement, confidence, sourceImport, '—', shard]);

    lines.splice(pendingRowIdx, 1);
    const teBounds2   = _findOrgSectionBounds(lines, /^\*\s+Aliases\s*(—|-)\s*type_element/i);
    const insertion2  = _findTableInsertionPoint(lines, teBounds2.start, teBounds2.end);
    if (insertion2) {
      lines.splice(insertion2.lastRowIdx + 1, 0, newRow);
    } else {
      lines.splice(teBounds2.end, 0, newRow);
    }

    if (opts.slot && opts.value) {
      const svBounds2   = _findOrgSectionBounds(lines, /^\*\s+Aliases\s*(—|-)\s*slot values/i);
      if (!svBounds2) throw new Error(`Section "Aliases — slot values" introuvable dans ${shard}.org`);
      const svRow = _makeOrgRow([cleanTerm, opts.slot.trim(), opts.value.trim(), confidence, sourceImport, '—', shard]);
      const svInsertion = _findTableInsertionPoint(lines, svBounds2.start, svBounds2.end);
      if (svInsertion) {
        lines.splice(svInsertion.lastRowIdx + 1, 0, svRow);
      } else {
        lines.splice(svBounds2.end, 0, svRow);
      }
    }

  } else {
    throw new Error(`action invalide : ${action} (attendu "confirm" ou "reject")`);
  }

  fs.writeFileSync(thesPath, lines.join('\n'), 'utf8');
  return { ok: true };
}

module.exports = { scanSandboxThesaurus, resolveThesaurusPending };
