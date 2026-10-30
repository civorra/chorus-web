/**
 * chorus/thesaurus.js — Lecture et résolution du thésaurus sandbox
 *
 * - scanSandboxThesaurus : lecture de tous les shards agent/thesaurus/*.org
 * - resolveThesaurusPending : confirme ou rejette une ligne Pending
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { SANDBOXES_DIR, readFileSafe, listDirs } = require('./fs');
const { extractOrgTable, parseImportReportOrg } = require('./parser');

// ── Résolution "Source import" → vrai fichier source ──────────────────────
//
// La colonne "Source import" des tables thésaurus contient le plus souvent
// un simple identifiant de rapport (ex: "import-report-003"), jamais le nom
// du fichier source réellement importé (ex: "cbom.cdx.json") — seules
// quelques lignes écrites manuellement portent un suffixe explicite
// "(workspace/test/reports/)". Or le filtrage par projet de la webapp
// (chorus-web.js § renderPvThesaurusTab) doit comparer des alignements
// thésaurus au fichier source du projet consulté (proj.sourceBasename,
// dérivé de _import.source_file) — pas au numéro de rapport qui les a
// produits. Deux imports distincts peuvent légitimement partager le même
// fichier source (ex: 5 réimports successifs du même CBOM), chacun avec son
// propre import-report-NNN.org : sans cette résolution, un alignement/Pending
// écrit lors d'un import antérieur reste invisible pour tout projet importé
// plus tard à partir de la même source — y compris alors que le lien est
// réel et pertinent (confirmé : incident sandbox 08-ANSSI-PG-083-CENTRIC,
// terme "ECIES-X25519-XSalsa20-Poly1305", Source import="import-report-003",
// jamais affiché pour project-import-cbom-001-cosmian-kms-v5.json bien que
// les deux partagent le même #+SOURCE: eviden/cbom.cdx.json).
//
// Résolution : chercher import-report-NNN.org dans TOUTES les
// workspace/<entity>/reports/ du sandbox (le numéro de rapport est unique
// sandbox-wide par convention, mais l'entity exacte n'est pas connue ici),
// et en extraire #+SOURCE: via parseImportReportOrg (déjà utilisé par
// collectImportHistory). Résultat mémoïsé par sbPath (invalidation : aucune,
// le scan est best-effort et reconstruit à chaque appel de scanSandboxThesaurus
// — acceptable, ces fichiers sont peu nombreux et cette fonction n'est pas
// sur un chemin chaud).
function _resolveSourceImportBasename(sbPath, sourceImport) {
  if (!sourceImport) return null;
  // Repli immédiat : certaines lignes portent déjà un nom de fichier
  // explicite entre parenthèses (convention legacy) — rien à résoudre.
  const inlineMatch = sourceImport.match(/\(([^)]+)\)/);
  if (inlineMatch) return path.basename(inlineMatch[1]).replace(/\.[^.]+$/, '');

  const reportId = sourceImport.trim(); // ex: "import-report-003"
  if (!/^import-report-\d+$/.test(reportId)) return null;

  const workspacePath = path.join(sbPath, 'workspace');
  for (const entity of listDirs(workspacePath)) {
    const reportPath = path.join(workspacePath, entity, 'reports', `${reportId}.org`);
    const content = readFileSafe(reportPath);
    if (!content) continue;
    const parsed = parseImportReportOrg(content);
    if (parsed.source) {
      // #+SOURCE: often carries a trailing format annotation, e.g.
      // "eviden/cbom.cdx.json (CycloneDX / CBOM)" — strip it before
      // extracting the basename, otherwise path.basename() would return
      // garbage (the annotation itself, not the file path).
      const sourcePath = parsed.source.replace(/\s*\([^)]*\)\s*$/, '').trim();
      return path.basename(sourcePath).replace(/\.[^.]+$/, '');
    }
  }
  return null;
}

// ── Scan des thésaurus ────────────────────────────────────────────────────
//
// WEB-027 — Architecture thésaurus refonte :
//
//   NOUVEAU (prioritaire) : workspace/<entity>/thesaurus.org
//     Un fichier par entity. Isolation totale. Aucun global cross-entity.
//
//   LEGACY (compat descendante) : agent/thesaurus/<context>.org
//     Sandboxes existants avant WEB-027. Lus en priorité si le fichier
//     workspace/<entity>/thesaurus.org n'existe pas encore.
//     Migration automatique au premier accès (voir _migrateThesaurusShard).
//
// Le champ `entity` remplace `shard` dans les objets retournés.
// L'ancien `shard` est conservé comme alias pour la compat des appelants.

function _thesaurusPathForEntity(sbPath, entity) {
  return path.join(sbPath, 'workspace', entity, 'thesaurus.org');
}

function _legacyThesaurusDir(sbPath) {
  return path.join(sbPath, 'agent', 'thesaurus');
}

/**
 * Migre silencieusement un shard legacy agent/thesaurus/<shard>.org vers
 * workspace/<entity>/thesaurus.org si le fichier destination n'existe pas.
 * Ne supprime pas le fichier source (transition douce).
 * Retourne le chemin effectivement utilisé.
 */
function _migrateThesaurusShard(sbPath, entity, legacyFile) {
  const dest = _thesaurusPathForEntity(sbPath, entity);
  if (fileExists(dest)) return dest;          // déjà migré
  if (!legacyFile || !fileExists(legacyFile)) return dest; // rien à migrer
  try {
    const content = fs.readFileSync(legacyFile, 'utf8');
    const migrated = `# MIGRATED from agent/thesaurus/ by WEB-027 — do not edit the legacy file\n${content}`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, migrated, 'utf8');
  } catch { /* migration non-bloquante */ }
  return dest;
}

/**
 * Collecte la liste des entities connues pour ce sandbox.
 * Sources (par ordre de priorité) :
 *  1. workspace/<entity>/thesaurus.org      ← nouveau (WEB-027)
 *  2. agent/thesaurus/<context>.org         ← legacy (pre-WEB-027)
 * Les entities "global" du legacy sont gardées comme entité "global" dans
 * les résultats de transition mais ne doivent plus être créées par de
 * nouveaux imports.
 */
function _collectThesaurusEntities(sbPath) {
  const entities = new Map(); // entity → { newPath, legacyPath }

  // Sources nouvelles (workspace/<entity>/thesaurus.org)
  const workspacePath = path.join(sbPath, 'workspace');
  try {
    for (const entry of listDirs(workspacePath)) {
      const p = _thesaurusPathForEntity(sbPath, entry);
      if (fileExists(p)) entities.set(entry, { newPath: p, legacyPath: null });
    }
  } catch {}

  // Sources legacy (agent/thesaurus/*.org)
  const legacyDir = _legacyThesaurusDir(sbPath);
  try {
    const files = fs.readdirSync(legacyDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.org'));
    for (const f of files) {
      const entity = f.name.replace(/\.org$/, '');
      if (!entities.has(entity)) {
        // Pas encore de fichier nouveau → déclenche migration silencieuse
        const legacyPath = path.join(legacyDir, f.name);
        const migratedPath = _migrateThesaurusShard(sbPath, entity, legacyPath);
        entities.set(entity, { newPath: migratedPath, legacyPath });
      }
    }
  } catch {}

  return entities;
}

function scanSandboxThesaurus(sbPath) {
  const resolveCache = new Map();
  const resolve = (sourceImport) => {
    if (!sourceImport) return null;
    if (!resolveCache.has(sourceImport))
      resolveCache.set(sourceImport, _resolveSourceImportBasename(sbPath, sourceImport));
    return resolveCache.get(sourceImport);
  };

  const entities = _collectThesaurusEntities(sbPath);
  if (!entities.size) return [];

  return Array.from(entities.entries()).map(([entity, { newPath }]) => {
    const content = readFileSafe(newPath);
    // `entity` est le nouveau nom canonique ; `shard` maintenu pour compat appelants
    if (!content) return { entity, shard: entity, aliasesTypeElement: [], aliasesSlotValues: [], pending: [], outOfScope: [] };

    const aliasesTypeElement = extractOrgTable(content, /^\*\s+Aliases\s*(—|-)\s*type_element/i)
      .slice(1).map(r => ({ term: r[0], target: r[1], confidence: r[2], sourceImport: r[3] || null,
        sourceBasename: resolve(r[3] || null) }));
    const aliasesSlotValues = extractOrgTable(content, /^\*\s+Aliases\s*(—|-)\s*slot values/i)
      .slice(1).map(r => ({ term: r[0], slot: r[1], value: r[2], confidence: r[3], sourceImport: r[4] || null,
        sourceBasename: resolve(r[4] || null) }));
    const pending = extractOrgTable(content, /^\*\s+Pending/i)
      .slice(1).map(r => ({
        term: r[0], proposed: r[1], flag: r[2], sourceImport: r[3] || null,
        scope: r[4] ? r[4].trim() : null,
        sourceBasename: resolve(r[3] || null),
      }));
    const outOfScope = extractOrgTable(content, /^\*\s+Out-of-scope/i)
      .slice(1).map(r => ({ term: r[0], reason: r[1] }));

    return { entity, shard: entity, aliasesTypeElement, aliasesSlotValues, pending, outOfScope };
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
    `               WEB-027: this file is the canonical location (workspace/<entity>/thesaurus.org).`,
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

// ── Helpers de résolution de chemin (WEB-027) ────────────────────────────
//
// Règle : workspace/<entity>/thesaurus.org est le chemin canonique.
// Fallback lecture : agent/thesaurus/<entity>.org (legacy pré-WEB-027).
// Écriture : toujours vers workspace/<entity>/thesaurus.org,
//            sauf "global" (legacy maintenu en lecture/écriture pour compat).

function _thesaurusReadPathForShard(sbPath, shard) {
  if (shard === 'global') return path.join(sbPath, 'agent', 'thesaurus', 'global.org');
  const newPath = _thesaurusPathForEntity(sbPath, shard);
  if (fileExists(newPath)) return newPath;
  return path.join(sbPath, 'agent', 'thesaurus', `${shard}.org`); // legacy fallback
}

function _thesaurusWritePathForShard(sbPath, shard) {
  if (shard === 'global') return path.join(sbPath, 'agent', 'thesaurus', 'global.org');
  const newPath = _thesaurusPathForEntity(sbPath, shard);
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  return newPath;
}

function resolveThesaurusPending(sbId, shard, term, sourceImport, action, opts = {}) {
  const sbPath   = path.join(SANDBOXES_DIR(), sbId);
  // WEB-027 : lire depuis workspace/<entity>/thesaurus.org (ou legacy agent/thesaurus/)
  const globalPath = _thesaurusReadPathForShard(sbPath, shard);
  const content    = readFileSafe(globalPath);
  if (content == null) throw new Error(`Shard thesaurus introuvable : ${shard}`);

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
  //    Reject → même fichier que Pending (Out-of-scope dans le même thésaurus)
  //    Confirm → workspace/<targetScope>/thesaurus.org (WEB-027)
  const targetShardPath = (action === 'confirm' && targetScope !== 'global')
    ? _thesaurusWritePathForShard(sbPath, targetScope)
    : globalPath;
  const targetShardName = (action === 'confirm' && targetScope !== 'global')
    ? targetScope
    : shard;

  // 4) Backup avant écriture.
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

    // WEB-027 — Promote to entity : confidence distincte + sourceImport effacé
    // (l'alias s'applique à TOUS les futurs imports de l'entity, sans restriction).
    const isEntityPromote = opts.entityPromote === true;
    const confidence = isEntityPromote
      ? `✅ entity-promoted (validated via chorus-web ${today})`
      : `✅ confirmed (validated via chorus-web ${today})`;

    // Supprimer la ligne de Pending dans global.org.
    lines.splice(pendingRowIdx, 1);
    fs.writeFileSync(globalPath, lines.join('\n'), 'utf8');

    // Charger (ou créer) le shard cible pour écrire les Aliases.
    if (targetShardPath !== globalPath && !fs.existsSync(targetShardPath)) {
      _createClientShard(targetShardPath, sbId, targetScope);
    }
    const targetContent  = readFileSafe(targetShardPath) || '';
    const targetLines    = targetContent.split('\n');

    // sourceImport dans l'alias :
    //   - promote → marqueur "entity-promotion YYYY-MM-DD" (pas de restriction d'import)
    //   - confirm normal → sourceImport original conservé (projet-spécifique)
    const aliasSourceImport = isEntityPromote ? `entity-promotion ${today}` : sourceImport;

    // Ajouter dans Aliases — type_element du shard cible.
    const teRow = _makeOrgRow([cleanTerm, typeElement, confidence, aliasSourceImport, '—', targetScope]);
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
      const svRow = _makeOrgRow([cleanTerm, opts.slot.trim(), opts.value.trim(), confidence, aliasSourceImport, '—', targetScope]);
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

// ── Annulation d'une confirmation manuelle ────────────────────────────────
//
// Symétrique de resolveThesaurusPending(action='confirm') : remet un alias
// confirmé manuellement via chorus-web dans * Pending (global.org), pour
// permettre à l'engineer de revenir sur une décision prise par erreur.
//
// ⛔ Garde-fou strict : n'opère JAMAIS sur un alias résolu à l'import
// (confidence = "✅ confirmed" sans suffixe "validated via chorus-web") —
// ces alignements sont la responsabilité de chorus-import-project et ne
// doivent jamais être rouverts depuis la webapp sans repasser par un import.
// Voir chorus-web.js § _pvThesOrigin pour la même distinction côté lecture.
//
// shard  = nom du shard où vit la ligne Aliases à annuler (ex: 'global',
//          'client-alpha') — PAS nécessairement 'global', contrairement à
//          resolveThesaurusPending où le shard source est toujours global.org
//          pour les lignes Pending.
function unconfirmThesaurusAlias(sbId, shard, term, sourceImport, opts = {}) {
  const sbPath    = path.join(SANDBOXES_DIR(), sbId);
  // WEB-027 : lire depuis workspace/<entity>/ ou legacy agent/thesaurus/
  const shardPath = _thesaurusReadPathForShard(sbPath, shard);
  const content   = readFileSafe(shardPath);
  if (content == null) throw new Error(`Shard thesaurus introuvable : ${shard}`);

  const lines = content.split('\n');

  // 1) Localiser la ligne Aliases (type_element OU slot values) à annuler.
  //    On cherche dans les deux sections, une seule doit matcher (term, sourceImport).
  const sections = [
    { heading: /^\*\s+Aliases\s*(—|-)\s*type_element/i, kind: 'type_element' },
    { heading: /^\*\s+Aliases\s*(—|-)\s*slot values/i,  kind: 'slot_value' },
  ];

  let found = null; // { bounds, rowIdx, cells, kind }
  for (const sec of sections) {
    const bounds = _findOrgSectionBounds(lines, sec.heading);
    if (!bounds) continue;
    for (let i = bounds.start; i < bounds.end; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed.startsWith('|') || /^\|[-+]+\|?$/.test(trimmed)) continue;
      const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
      if (cells[0] === 'Project term') continue;
      // Colonnes : type_element → [term, target, confidence, sourceImport, ...]
      //            slot_value   → [term, slot, value, confidence, sourceImport, ...]
      const srcCol = sec.kind === 'type_element' ? cells[3] : cells[4];
      if (cells[0] === term && srcCol === sourceImport) {
        found = { bounds, rowIdx: i, cells, kind: sec.kind };
        break;
      }
    }
    if (found) break;
  }
  if (!found) {
    throw new Error(`Alias confirmé introuvable pour terme="${term}" source="${sourceImport}" dans ${shard}.org`);
  }

  // 2) Garde-fou : refuser si l'alias n'a pas été confirmé manuellement.
  const confidenceCol = found.kind === 'type_element' ? found.cells[2] : found.cells[3];
  if (!/validated via chorus-web/i.test(confidenceCol || '')) {
    throw new Error(
      `Cet alias a été résolu à l'import (chorus-import-project), pas via chorus-web — ` +
      `annulation refusée (confidence="${confidenceCol}"). Seules les confirmations ` +
      `manuelles peuvent être annulées depuis la webapp.`
    );
  }

  // 3) Backup avant écriture.
  const backupDir = path.join(sbPath, 'agent', '.backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  fs.writeFileSync(path.join(backupDir, `${shard}.org.bak-${ts}`), content, 'utf8');

  // 4) Supprimer la ligne Aliases du shard source.
  lines.splice(found.rowIdx, 1);
  fs.writeFileSync(shardPath, lines.join('\n'), 'utf8');

  // 5) Reconstruire une ligne Pending dans le même fichier (WEB-027 — Pending
  //    est entity-scoped, pas global). Compat descendante : si shard = 'global',
  //    écrire dans global.org comme avant.
  const proposed = found.kind === 'type_element'
    ? `type_element: ${found.cells[1]} ?`
    : `${found.cells[1]}: ${found.cells[2]} ?`;
  const pendingRow = _makeOrgRow([term, proposed, '⚠️ _a_confirmer', sourceImport, shard]);

  const pendingBounds = _findOrgSectionBounds(lines, /^\*\s+Pending/i);
  if (!pendingBounds) throw new Error(`Section "Pending" introuvable dans ${shard}`);
  const pendingInsertion = _findTableInsertionPoint(lines, pendingBounds.start, pendingBounds.end);
  if (pendingInsertion) {
    lines.splice(pendingInsertion.lastRowIdx + 1, 0, pendingRow);
  } else {
    lines.splice(pendingBounds.end, 0, pendingRow);
  }
  fs.writeFileSync(shardPath, lines.join('\n'), 'utf8');

  // 6) Journal de décisions terminologiques (best-effort — jamais bloquant).
  try {
    _appendThesaurusLog(sbPath, opts.entityId, opts.projectId, opts.projectName, {
      date:         new Date().toISOString().slice(0, 10),
      term,
      action:       '↩️ Annulé (retour en Pending)',
      typeElement:  found.kind === 'type_element' ? found.cells[1] : null,
      slot:         found.kind === 'slot_value' ? found.cells[1] : null,
      value:        found.kind === 'slot_value' ? found.cells[2] : null,
      shard,
      sourceImport,
    });
  } catch { /* ne jamais bloquer pour le log */ }

  return { ok: true, shard, scope: shard };
}

module.exports = { scanSandboxThesaurus, resolveThesaurusPending, unconfirmThesaurusAlias };
