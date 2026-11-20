/**
 * chorus/thesaurus.js — Lecture et résolution du thésaurus sandbox
 *
 * - scanSandboxThesaurus : lecture de tous les shards agent/thesaurus/*.org
 * - resolveThesaurusPending : confirme ou rejette une ligne Pending
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { SANDBOXES_DIR, readFileSafe, listDirs, fileExists } = require('./fs');
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
    // Fallback : ECA écrit le fichier source dans la section "* Source"
    // sous la forme "  Fichier  : <path>" (pas de #+SOURCE: header).
    const fichierMatch = content.match(/Fichier\s*:\s*(\S+)/);
    if (fichierMatch) {
      const sourcePath = fichierMatch[1].replace(/\s*\([^)]*\)\s*$/, '').trim();
      return path.basename(sourcePath).replace(/\.[^.]+$/, '');
    }
  }
  return null;
}

// Entity-aware variant of _resolveSourceImportBasename.
//
// WEB-028 — fix régression « onglet thésaurus vide » :
//
// Plusieurs entités d'un même sandbox utilisent des compteurs séquentiels
// pour leurs rapports d'import (import-report-001.org, import-report-002.org…).
// Le scanner global _resolveSourceImportBasename() parcourt TOUS les dossiers
// workspace/<entity>/reports/ et retourne le PREMIER fichier trouvé — donc
// toujours celui de l'entité alphabétiquement la plus basse (ex : "Alencon")
// quelle que soit l'entité traitée. Résultat : sourceBasename est incorrect
// pour toutes les entités qui viennent après alphabétiquement → les entrées
// du thésaurus ne correspondent plus à la cible proj.sourceBasename dans la
// webapp → onglet thésaurus vide.
//
// Solution : vérifier d'abord le dossier reports/ de l'entité courante avant
// de tomber sur le scan global. Le scan global reste actif comme fallback pour
// les IDs globalement uniques de la forme "import-report-<timestamp>" (sandboxes
// récents, ex : eviden), où le report ne sera trouvé que dans une seule entité.
function _resolveSourceImportBasenameInEntity(sbPath, entity, sourceImport) {
  if (!sourceImport) return null;
  // Repli immédiat : certaines lignes portent déjà un nom de fichier explicite.
  const inlineMatch = sourceImport.match(/\(([^)]+)\)/);
  if (inlineMatch) return path.basename(inlineMatch[1]).replace(/\.[^.]+$/, '');

  const reportId = sourceImport.trim();
  if (!/^import-report-\d+$/.test(reportId)) return null;

  // 1) Chercher d'abord dans l'entité fournie.
  const entityReportPath = path.join(sbPath, 'workspace', entity, 'reports', `${reportId}.org`);
  const entityContent = readFileSafe(entityReportPath);
  if (entityContent) {
    const parsed = parseImportReportOrg(entityContent);
    if (parsed.source) {
      const sourcePath = parsed.source.replace(/\s*\([^)]*\)\s*$/, '').trim();
      return path.basename(sourcePath).replace(/\.[^.]+$/, '');
    }
    const fichierMatch = entityContent.match(/Fichier\s*:\s*(\S+)/);
    if (fichierMatch) {
      const sourcePath = fichierMatch[1].replace(/\s*\([^)]*\)\s*$/, '').trim();
      return path.basename(sourcePath).replace(/\.[^.]+$/, '');
    }
  }

  // 2) Fallback : scan global (IDs globalement uniques comme "import-report-<timestamp>").
  return _resolveSourceImportBasename(sbPath, sourceImport);
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
 *  2. workspace/<entity>/*.thesaurus.json   ← Niveau 2 (projet) — cf. ci-dessous
 *  3. agent/thesaurus/<context>.org         ← legacy (pre-WEB-027)
 * Les entities "global" du legacy sont gardées comme entité "global" dans
 * les résultats de transition mais ne doivent plus être créées par de
 * nouveaux imports.
 *
 * ⛔ Fix (onglet Thésaurus vide après reset manuel de l'entity) : avant ce
 * correctif, une entity n'était détectée QUE via la présence physique de
 * `thesaurus.org` (ou son legacy). Si ce fichier est supprimé manuellement
 * (reset d'entity, nettoyage sandbox) puis qu'un nouveau projet est importé,
 * chorus-import-project peut créer `<projId>.thesaurus.json` (Niveau 2, avec
 * des entrées Pending) SANS recréer `thesaurus.org` — l'entity entière
 * devenait alors invisible au scanner, y compris ses Pending Niveau 2, sans
 * aucun message d'erreur côté webapp ("Aucun thesaurus trouvé" trompeur,
 * l'entity existe bel et bien). Un `.thesaurus.json` présent est désormais
 * un signal suffisant pour détecter l'entity, au même titre que `thesaurus.org`
 * — avec création à la volée d'un `thesaurus.org` squelette si absent (même
 * logique que la migration legacy ci-dessous), pour que toute écriture
 * ultérieure (confirm/reject/promote) ait un fichier cible valide.
 * (Incident : sandbox 08-ANSSI-PG-083-CENTRIC, entity Apache, reset manuel
 * 2026-11-20 avant re-import de project-import-1795166275755.)
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

  // Niveau 2 — workspace/<entity>/*.thesaurus.json sans thesaurus.org associé.
  // Détecte l'entity même si thesaurus.org a été supprimé/jamais créé ; crée
  // un thesaurus.org squelette à la volée pour fournir un fichier cible aux
  // écritures Niveau 3 futures (promotion, out-of-scope, conflicts).
  try {
    for (const entry of listDirs(workspacePath)) {
      if (entities.has(entry)) continue; // déjà détectée via thesaurus.org
      const entityDir = path.join(workspacePath, entry);
      let hasProjectThesaurus = false;
      try {
        hasProjectThesaurus = fs.readdirSync(entityDir, { withFileTypes: true })
          .some(f => f.isFile() && f.name.endsWith('.thesaurus.json'));
      } catch { continue; }
      if (!hasProjectThesaurus) continue;
      const newPath = _thesaurusPathForEntity(sbPath, entry);
      if (!fileExists(newPath)) _createClientShard(newPath, path.basename(sbPath), entry);
      entities.set(entry, { newPath, legacyPath: null });
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

// Helper local (miroir de chorus-web.js § _basenameNoExt)
function _basenameNoExt(p) {
  if (!p) return null;
  const base = p.split('/').pop();
  return base.replace(/\.[^.]+$/, '');
}

// ── Niveau 2 — Thésaurus projet (workspace/<entity>/<projId>.thesaurus.json) ──
//
// WEB-027 architecture 3 niveaux :
//   Niveau 1 — KB / CBOM-oid-registry.yml (automatique, hors thésaurus)
//   Niveau 2 — Projet : workspace/<entity>/<projId>.thesaurus.json
//              Défaut pour les confirmations manuelles de la webapp.
//              N'affecte que le projet concerné.
//   Niveau 3 — Entity : workspace/<entity>/thesaurus.org
//              Promotion explicite uniquement (bouton "Promouvoir à l'entity").
//              Jamais cross-entity. Jamais automatique.
//
// La confirmation via "Valider" dans le panneau thésaurus → Niveau 2.
// La confirmation via "Promouvoir à l'entity" → Niveau 3 (entityPromote: true).

function _projectThesaurusPath(sbPath, entity, projId) {
  return path.join(sbPath, 'workspace', entity, `${projId}.thesaurus.json`);
}

function _readProjectThesaurus(sbPath, entity, projId) {
  const p = _projectThesaurusPath(sbPath, entity, projId);
  const content = readFileSafe(p);
  if (!content) return { _meta: {}, aliases_type_element: [], aliases_slot_values: [], pending: [], out_of_scope: [] };
  try { return JSON.parse(content); }
  catch { return { _meta: {}, aliases_type_element: [], aliases_slot_values: [], pending: [], out_of_scope: [] }; }
}

function _writeToProjectThesaurus(sbPath, entity, projId, section, entry) {
  const p = _projectThesaurusPath(sbPath, entity, projId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const data = _readProjectThesaurus(sbPath, entity, projId);
  const today = new Date().toISOString().slice(0, 10);
  if (!data._meta.proj_id) {
    data._meta = { sandbox: path.basename(sbPath), entity, proj_id: projId, created: today, updated: today };
  } else {
    data._meta.updated = today;
  }
  data[section] = data[section] || [];
  // Dédoublonnage : ne pas écrire deux fois le même terme dans la même section.
  const isDuplicate = data[section].some(e =>
    e.term === entry.term &&
    (section === 'aliases_type_element' ? e.type_element === entry.type_element :
     section === 'aliases_slot_values'  ? e.slot === entry.slot && e.value === entry.value : false)
  );
  if (!isDuplicate) data[section].push(entry);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Collecte tous les fichiers <projId>.thesaurus.json présents dans
 * workspace/<entity>/ pour un sandbox donné.
 * Retourne [{projId, path}].
 */
function _collectProjectThesauri(sbPath, entity) {
  const entityWsPath = path.join(sbPath, 'workspace', entity);
  const results = [];
  try {
    const files = fs.readdirSync(entityWsPath, { withFileTypes: true });
    for (const f of files) {
      if (f.isFile() && f.name.endsWith('.thesaurus.json')) {
        const projId = f.name.replace(/\.thesaurus\.json$/, '');
        results.push({ projId, path: path.join(entityWsPath, f.name) });
      }
    }
  } catch { /* entity dir absente ou illisible — non-bloquant */ }
  return results;
}

function scanSandboxThesaurus(sbPath) {
  // Resolver global (IDs uniques sandbox-wide, ex: "import-report-<timestamp>").
  // ⚠️ NE PAS utiliser pour les ID séquentiels (import-report-001…) qui sont
  // scopés par entité — utiliser resolveForEntity() à la place (WEB-028).
  const resolveCache = new Map();
  const resolve = (sourceImport) => {
    if (!sourceImport) return null;
    if (!resolveCache.has(sourceImport))
      resolveCache.set(sourceImport, _resolveSourceImportBasename(sbPath, sourceImport));
    return resolveCache.get(sourceImport);
  };

  // WEB-028 — resolver entity-aware avec cache par entité.
  // Priorité : reports/<entity>/ en premier, fallback scan global.
  // Évite la collision quand plusieurs entités partagent le même numéro
  // séquentiel (import-report-001.org, import-report-002.org…).
  const entityResolveCaches = new Map(); // entity → Map(sourceImport → basename)
  const resolveForEntity = (entity, sourceImport) => {
    if (!sourceImport) return null;
    if (!entityResolveCaches.has(entity)) entityResolveCaches.set(entity, new Map());
    const cache = entityResolveCaches.get(entity);
    if (!cache.has(sourceImport))
      cache.set(sourceImport, _resolveSourceImportBasenameInEntity(sbPath, entity, sourceImport));
    return cache.get(sourceImport);
  };

  const entities = _collectThesaurusEntities(sbPath);
  if (!entities.size) return [];

  // ── Niveau 3 — shards entity (workspace/<entity>/thesaurus.org) ──────────
  const level3Shards = Array.from(entities.entries()).map(([entity, { newPath }]) => {
    const content = readFileSafe(newPath);
    // `entity` est le nouveau nom canonique ; `shard` maintenu pour compat appelants
    if (!content) return { entity, shard: entity, level: 3, projId: null, aliasesTypeElement: [], aliasesSlotValues: [], pending: [], outOfScope: [] };

    // WEB-028 : utiliser le resolver entity-aware pour les IDs séquentiels.
    const res = (si) => resolveForEntity(entity, si);

    const aliasesTypeElement = extractOrgTable(content, /^\*\s+Aliases\s*(—|-)\s*type_element/i)
      .slice(1).map(r => ({ term: r[0], target: r[1], confidence: r[2], sourceImport: r[3] || null,
        sourceBasename: res(r[3] || null) }));
    const aliasesSlotValues = extractOrgTable(content, /^\*\s+Aliases\s*(—|-)\s*slot values/i)
      .slice(1).map(r => ({ term: r[0], slot: r[1], value: r[2], confidence: r[3], sourceImport: r[4] || null,
        sourceBasename: res(r[4] || null) }));
    const pending = extractOrgTable(content, /^\*\s+Pending/i)
      .slice(1).map(r => ({
        term: r[0], proposed: r[1], flag: r[2], sourceImport: r[3] || null,
        scope: r[4] ? r[4].trim() : null,
        sourceBasename: res(r[3] || null),
      }));
    const outOfScope = extractOrgTable(content, /^\*\s+Out-of-scope/i)
      .slice(1).map(r => ({ term: r[0], reason: r[1] }));

    // P-18 fix — extraire * Conflicts (mapping collision cross-import).
    // Colonnes : term | existing mapping | new mapping | source import (optionnel)
    const conflicts = extractOrgTable(content, /^\*\s+Conflicts?/i)
      .slice(1)
      .filter(r => r[0] && r[0] !== 'Project term')
      .map(r => ({
        term:            r[0] || '',
        existingMapping: r[1] || '',
        newMapping:      r[2] || '',
        sourceImport:    r[3] || null,
      }));

    return { entity, shard: entity, level: 3, projId: null, aliasesTypeElement, aliasesSlotValues, pending, outOfScope, conflicts };
  });

  // ── Niveau 2 — shards projet (workspace/<entity>/<projId>.thesaurus.json) ─
  const level2Shards = [];
  for (const [entity] of entities.entries()) {
    // WEB-028 : resolver entity-aware pour les IDs séquentiels.
    const res2 = (si) => resolveForEntity(entity, si);

    for (const { projId, path: projPath } of _collectProjectThesauri(sbPath, entity)) {
      const content = readFileSafe(projPath);
      if (!content) continue;
      let data;
      try { data = JSON.parse(content); } catch { continue; }
      level2Shards.push({
        entity,
        shard: entity,
        level: 2,
        projId,
        aliasesTypeElement: (data.aliases_type_element || []).map(a => ({
          term: a.term, target: a.type_element, confidence: a.confidence,
          sourceImport: a.source_import || null,
          sourceBasename: a.source_import ? res2(a.source_import) : null,
        })),
        aliasesSlotValues: (data.aliases_slot_values || []).map(a => ({
          term: a.term, slot: a.slot, value: a.value, confidence: a.confidence,
          sourceImport: a.source_import || null,
          sourceBasename: a.source_import ? res2(a.source_import) : null,
        })),
        // ENG-071 — Pending vit en Niveau 2 (project JSON § "pending"), plus en Niveau 3 entity org.
        pending: (data.pending || []).map(p => ({
          term:            p.term,
          proposed:        p.proposed_mapping || '',
          flag:            p.flag || '⚠️ _a_confirmer',
          sourceImport:    p.source_import || null,
          scope:           null,
          sourceBasename:  p.source_import ? res2(p.source_import) : null,
        })),
        outOfScope: (data.out_of_scope || []).map(a => ({ term: a.term, reason: a.reason || '' })),
      });
    }
  }

  return [...level3Shards, ...level2Shards];
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

// ── ENG-071 — Résolution d'une entrée Pending en Niveau 2 (project JSON) ──
//
// Appelé par resolveThesaurusPending quand le terme n'est pas trouvé dans
// thesaurus.org § * Pending (car ENG-071 a déplacé le Pending vers le JSON projet).
//
// confirm → retire de data.pending + écrit dans data.aliases_type_element (Niveau 2)
// reject  → retire de data.pending + écrit dans thesaurus.org § * Out-of-scope (entité)

function _resolvePendingFromProjectJson(sbPath, shard, term, sourceImport, action, opts) {
  const { projectId, entityId } = opts;
  const projPath = _projectThesaurusPath(sbPath, entityId, projectId);
  const raw      = readFileSafe(projPath);
  if (!raw) throw new Error(`Thésaurus projet introuvable : ${projPath}`);
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`JSON invalide : ${projPath}`); }

  const pendingArr = data.pending || [];
  const idx = pendingArr.findIndex(p => p.term === term && p.source_import === sourceImport);
  if (idx === -1) {
    throw new Error(`Entrée Pending introuvable pour terme="${term}" source="${sourceImport}" dans ${projectId}.thesaurus.json`);
  }

  const entry = pendingArr[idx];
  const today = new Date().toISOString().slice(0, 10);

  // Backup JSON avant écriture
  const backupDir = path.join(sbPath, 'agent', '.backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  fs.writeFileSync(path.join(backupDir, `${projectId}.thesaurus.json.bak-${ts}`), raw, 'utf8');

  // Supprimer de pending
  pendingArr.splice(idx, 1);
  data.pending = pendingArr;
  if (!data._meta) data._meta = {};
  data._meta.updated = today;

  if (action === 'confirm') {
    const typeElement = (opts.typeElement || '').trim();
    if (!typeElement) throw new Error('typeElement requis pour confirmer');
    const confidence = `✅ confirmed (validated via chorus-web ${today} — project-scoped)`;
    data.aliases_type_element = data.aliases_type_element || [];
    const isDup = data.aliases_type_element.some(a => a.term === term && a.type_element === typeElement);
    if (!isDup) {
      data.aliases_type_element.push({ term, type_element: typeElement, confidence, source_import: sourceImport });
    }
    if (opts.slot && opts.value) {
      data.aliases_slot_values = data.aliases_slot_values || [];
      const isDupSv = data.aliases_slot_values.some(a => a.term === term && a.slot === opts.slot && a.value === opts.value);
      if (!isDupSv) {
        data.aliases_slot_values.push({ term, slot: opts.slot.trim(), value: opts.value.trim(), confidence, source_import: sourceImport });
      }
    }
    fs.writeFileSync(projPath, JSON.stringify(data, null, 2), 'utf8');

  } else if (action === 'reject') {
    // Out-of-scope → thesaurus.org entité (entity-scoped)
    fs.writeFileSync(projPath, JSON.stringify(data, null, 2), 'utf8');
    const orgPath    = _thesaurusWritePathForShard(sbPath, shard);
    const orgContent = readFileSafe(orgPath) || '';
    const orgLines   = orgContent.split('\n');
    const outBounds  = _findOrgSectionBounds(orgLines, /^\*\s+Out-of-scope/i);
    if (outBounds) {
      const newRow = _makeOrgRow([term, entry.proposed_mapping || entry.note || '—', '—', sourceImport]);
      const insertion = _findTableInsertionPoint(orgLines, outBounds.start, outBounds.end);
      if (insertion) orgLines.splice(insertion.lastRowIdx + 1, 0, newRow);
      else           orgLines.splice(outBounds.end, 0, newRow);
      fs.writeFileSync(orgPath, orgLines.join('\n'), 'utf8');
    }
  } else {
    throw new Error(`action invalide : ${action}`);
  }

  // Journal (best-effort)
  try {
    _appendThesaurusLog(sbPath, entityId, projectId, opts.projectName, {
      date: today, term,
      action:      action === 'confirm' ? '✅ Confirmé (Niveau 2)' : '❌ Rejeté (hors-périmètre)',
      typeElement: action === 'confirm' ? (opts.typeElement || '').trim() : null,
      slot:        action === 'confirm' ? (opts.slot  || '').trim() || null : null,
      value:       action === 'confirm' ? (opts.value || '').trim() || null : null,
      shard:       projectId,
      sourceImport,
    });
  } catch { /* non-bloquant */ }

  return { ok: true, targetShard: projectId, scope: entityId, level: 2 };
}

// ── Cascade de promotion entity (P-19 fix) ────────────────────────────────
//
// Après qu'un terme est promu au Niveau 3 (thesaurus.org § * Aliases) depuis
// un projet donné, scanner tous les <projId>.thesaurus.json de la même entity
// et migrer ce terme de § pending → § aliases_type_element (cascade confidence)
// si le mapping proposé est compatible, ou signaler un conflit dans
// thesaurus.org § * Conflicts si le mapping proposé est différent.
//
// Best-effort : les erreurs sur fichiers individuels ne bloquent jamais la
// promotion principale. Retourne { cascaded, conflicted } (arrays de projIds).

function _cascadeEntityPromote(sbPath, entity, term, typeElement, slot, value, promotingProjId, today, orgPath) {
  const cascaded   = [];
  const conflicted = [];

  try {
    for (const { projId, path: projPath } of _collectProjectThesauri(sbPath, entity)) {
      if (projId === promotingProjId) continue;

      const raw = readFileSafe(projPath);
      if (!raw) continue;
      let data;
      try { data = JSON.parse(raw); } catch { continue; }

      const pendingArr = data.pending || [];
      const idx = pendingArr.findIndex(p => p.term === term);
      if (idx === -1) continue;

      const entry          = pendingArr[idx];
      const proposed       = (entry.proposed_mapping || '').trim();
      // Extrait le type_element depuis "type_element: X ?" ou "type_element: X"
      const teMatch        = proposed.match(/^type_element:\s*(.+?)\s*\??$/i);
      const proposedTE     = teMatch ? teMatch[1].trim() : null;
      const isConflict     = proposedTE && proposedTE !== typeElement;
      const isCompatible   = !isConflict;

      if (isConflict) {
        // Conflit : laisser en pending + écrire dans thesaurus.org § * Conflicts
        conflicted.push(projId);
        try {
          const orgContent  = readFileSafe(orgPath) || '';
          const orgLines    = orgContent.split('\n');
          const conflRow    = _makeOrgRow([
            term,
            `${proposedTE} (${projId})`,
            `${typeElement} (entity-promoted from ${promotingProjId})`,
            entry.source_import || '—',
          ]);
          const conflBounds = _findOrgSectionBounds(orgLines, /^\*\s+Conflicts?/i);
          if (conflBounds) {
            const ins = _findTableInsertionPoint(orgLines, conflBounds.start, conflBounds.end);
            if (ins) orgLines.splice(ins.lastRowIdx + 1, 0, conflRow);
            else     orgLines.splice(conflBounds.end, 0, conflRow);
          } else {
            // Créer la section * Conflicts si elle n'existe pas encore
            orgLines.push(
              '', '* Conflicts',
              '  Mapping collisions between imports — arbitrage requis.',
              '',
              '  | Project term | Existing mapping | Conflicting mapping | Source import |',
              '  |---|---|---|---|',
              conflRow
            );
          }
          fs.writeFileSync(orgPath, orgLines.join('\n'), 'utf8');
        } catch { /* non-bloquant */ }
        continue;
      }

      if (isCompatible) {
        // Compatible : migrer de pending → aliases (cascade confidence)
        cascaded.push(projId);
        const cascadeConf = `✅ entity-promoted (cascade from ${promotingProjId} — ${today})`;

        pendingArr.splice(idx, 1);
        data.pending = pendingArr;

        data.aliases_type_element = data.aliases_type_element || [];
        const isDupTe = data.aliases_type_element.some(
          a => a.term === term && a.type_element === typeElement
        );
        if (!isDupTe) {
          data.aliases_type_element.push({
            term,
            type_element: typeElement,
            confidence:   cascadeConf,
            source_import: entry.source_import || null,
          });
        }

        if (slot && value) {
          data.aliases_slot_values = data.aliases_slot_values || [];
          const isDupSv = data.aliases_slot_values.some(
            a => a.term === term && a.slot === slot && a.value === value
          );
          if (!isDupSv) {
            data.aliases_slot_values.push({
              term,
              slot:         slot.trim(),
              value:        value.trim(),
              confidence:   cascadeConf,
              source_import: entry.source_import || null,
            });
          }
        }

        if (!data._meta) data._meta = {};
        data._meta.updated = today;
        try {
          fs.writeFileSync(projPath, JSON.stringify(data, null, 2), 'utf8');
        } catch { /* non-bloquant */ }
      }
    }
  } catch { /* scan failure non-bloquant */ }

  return { cascaded, conflicted };
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
    // ENG-071 — Pending vit désormais en Niveau 2 (project JSON § "pending").
    // Si introuvable dans thesaurus.org § * Pending, tenter le fallback JSON.
    if (opts.projectId && opts.entityId) {
      return _resolvePendingFromProjectJson(sbPath, shard, term, sourceImport, action, opts);
    }
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

    const isEntityPromote = opts.entityPromote === true;

    // WEB-027 — Niveau 2 : écriture dans workspace/<entity>/<projId>.thesaurus.json
    // quand confirm normal (pas de promote) + projectId disponible.
    // Niveau 3 : entity-promote OU pas de projectId → comportement org existant.
    const useLevel2 = !isEntityPromote && !!opts.projectId && !!opts.entityId && targetScope !== 'global';

    if (useLevel2) {
      // ── Niveau 2 : écriture JSON projet ──────────────────────────────────
      const confidence = `✅ confirmed (validated via chorus-web ${today} — project-scoped)`;
      _writeToProjectThesaurus(sbPath, opts.entityId, opts.projectId, 'aliases_type_element', {
        term: cleanTerm, type_element: typeElement, confidence,
        source_import: sourceImport, scope: opts.entityId, date: today,
      });
      if (opts.slot && opts.value) {
        _writeToProjectThesaurus(sbPath, opts.entityId, opts.projectId, 'aliases_slot_values', {
          term: cleanTerm, slot: opts.slot.trim(), value: opts.value.trim(),
          confidence, source_import: sourceImport, scope: opts.entityId, date: today,
        });
      }
      // Supprimer la ligne Pending du thésaurus entity (Niveau 3).
      lines.splice(pendingRowIdx, 1);
      fs.writeFileSync(globalPath, lines.join('\n'), 'utf8');

    } else {
      // ── Niveau 3 : écriture org entity (comportement existant) ────────────
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

      const aliasSourceImport = isEntityPromote ? `entity-promotion ${today}` : sourceImport;

      const teRow = _makeOrgRow([cleanTerm, typeElement, confidence, aliasSourceImport, '—', targetScope]);
      const teBounds = _findOrgSectionBounds(targetLines, /^\*\s+Aliases\s*(—|-)\s*type_element/i);
      if (!teBounds) throw new Error(`Section "Aliases — type_element" introuvable dans ${targetShardName}.org`);
      const teInsertion = _findTableInsertionPoint(targetLines, teBounds.start, teBounds.end);
      if (teInsertion) {
        targetLines.splice(teInsertion.lastRowIdx + 1, 0, teRow);
      } else {
        targetLines.splice(teBounds.end, 0, teRow);
      }

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

      // P-19 fix — cascade de la promotion vers les autres projets de l'entity.
      // Best-effort : ne jamais bloquer la promotion principale si la cascade échoue.
      if (isEntityPromote && opts.entityId) {
        try {
          const cascadeResult = _cascadeEntityPromote(
            sbPath,
            opts.entityId,
            cleanTerm,
            typeElement,
            opts.slot ? opts.slot.trim() : null,
            opts.value ? opts.value.trim() : null,
            opts.projectId || null,
            today,
            targetShardPath
          );
          // Log de la cascade (best-effort)
          if (cascadeResult.cascaded.length || cascadeResult.conflicted.length) {
            _appendThesaurusLog(sbPath, opts.entityId, opts.projectId, opts.projectName, {
              date:        today,
              term:        cleanTerm,
              action:      `🔄 Cascade promote → ${cascadeResult.cascaded.length} projet(s) mis à jour, ${cascadeResult.conflicted.length} conflit(s)`,
              typeElement,
              slot:        opts.slot ? opts.slot.trim() : null,
              value:       opts.value ? opts.value.trim() : null,
              shard:       targetShardName,
              sourceImport: `cascade-${cascadeResult.cascaded.join(',')}`,
            });
          }
        } catch { /* cascade non-bloquante */ }
      }
    }

    // Mise à jour du targetShardName pour le log
    if (useLevel2) {
      Object.assign(opts, { _resolvedShard: opts.projectId, _resolvedLevel: 2 });
    }

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

  const resolvedLevel = opts._resolvedLevel || 3;
  const resolvedShard = opts._resolvedLevel === 2 ? opts.projectId : (action === 'confirm' ? targetShardName : shard);
  return { ok: true, targetShard: resolvedShard, scope: targetScope, level: resolvedLevel };
}

// ── Détection de drift projet-JSON après annulation ───────────────────────
//
// Un alias confirmé peut déjà avoir été "compilé" dans <projId>.json lors
// d'un import/re-import antérieur (valeur figée en dur dans elements[].
// type_element ou elements[].<slot>, cf. chorus-import-project.md § Phase 3).
// unconfirmThesaurusAlias() ne touche jamais ce fichier (seul le thésaurus
// est modifié) — après une annulation, le JSON projet peut donc rester
// silencieusement périmé par rapport à la nouvelle vérité thésaurus (le
// terme est reparti en Pending, mais l'élément continue d'utiliser l'ancien
// mapping confirmé).
//
// Détection : chercher dans elements[] toute Frame dont _alignment_source
// mentionne le terme annulé (convention chorus-import-project.md — chaque
// résolution thésaurus appliquée à une Frame documente sa provenance dans
// ce champ texte libre, cf. incidents sandbox 08-ANSSI-PG-083-CENTRIC).
// Best-effort / non-bloquant : une correspondance manquée ne doit jamais
// empêcher l'annulation elle-même de réussir.
function _detectProjectJsonDrift(sbPath, entityId, projectId, term) {
  if (!entityId || !projectId || !term) return [];
  try {
    const projPath = path.join(sbPath, 'workspace', entityId, `${projectId}.json`);
    const raw = readFileSafe(projPath);
    if (!raw) return [];
    const data = JSON.parse(raw);
    const termLower = term.toLowerCase();
    return (data.elements || [])
      .filter(e => typeof e._alignment_source === 'string' && e._alignment_source.toLowerCase().includes(termLower))
      .map(e => e.id);
  } catch {
    return [];
  }
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
  const sbPath = path.join(SANDBOXES_DIR(), sbId);

  // ── Niveau 2 — workspace/<entity>/<projId>.thesaurus.json ────────────────
  // Tenter en priorité si projectId + entityId disponibles : les confirmations
  // "🔑 Valider (projet)" écrivent dans le JSON projet-scoped, pas dans le .org.
  if (opts.projectId && opts.entityId) {
    const lv2Path = _projectThesaurusPath(sbPath, opts.entityId, opts.projectId);
    const lv2Raw  = readFileSafe(lv2Path);
    let lv2Data;
    try { lv2Data = lv2Raw ? JSON.parse(lv2Raw) : null; } catch { lv2Data = null; }

    if (lv2Data) {
      const teArr = lv2Data.aliases_type_element || [];
      const svArr = lv2Data.aliases_slot_values  || [];
      const teIdx = teArr.findIndex(a => a.term === term && a.source_import === sourceImport);
      const svIdx = svArr.findIndex(a => a.term === term && a.source_import === sourceImport);

      if (teIdx >= 0 || svIdx >= 0) {
        // Garde-fou : refuser si l'alias n'a pas été confirmé manuellement
        const conf = teIdx >= 0 ? teArr[teIdx].confidence : svArr[svIdx].confidence;
        if (!/validated via chorus-web/i.test(conf || '')) {
          throw new Error(`Alias résolu à l'import — annulation refusée (confidence="${conf}")`);
        }
        // §2 — Refuser explicitement les alias promus à l'entity.
        // La promotion écrit dans le .org Niveau Entity et n'est jamais
        // stockée dans le JSON Niveau Projet, mais ce guard protège contre
        // toute évolution future et rend le refus symétrique avec la branche
        // Niveau Entity ci-dessous.
        if (/entity-promoted/i.test(conf || '')) {
          throw new Error(
            `Alias promu à l'entity (entity-promoted) — annulation non autorisée depuis la webapp ` +
            `(confidence="${conf}"). Cette promotion ne peut être révisée que via un ré-import.`
          );
        }

        const typeElement = teIdx >= 0 ? teArr[teIdx].type_element : null;
        const slot        = svIdx >= 0 ? svArr[svIdx].slot          : null;
        const value       = svIdx >= 0 ? svArr[svIdx].value         : null;

        // Fix P-16 (ENG-071) — réinsertion Pending dans le JSON projet (Niveau 2)
        // au lieu de thesaurus.org § * Pending (Niveau 3). Conforme à ENG-071 :
        // "Pending JAMAIS dans thesaurus.org § * Pending — toujours en Niveau 2".
        //
        // Avantage supplémentaire : toute la transaction (retrait aliases + ajout
        // pending) se fait en une seule écriture JSON atomique — plus besoin d'écrire
        // le .org en premier pour garantir la cohérence.

        const proposed   = typeElement
          ? `type_element: ${typeElement} ?`
          : (slot ? `${slot}: ${value} ?` : '');

        // Backup du JSON projet avant toute modification.
        const backupDir = path.join(sbPath, 'agent', '.backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
        if (lv2Raw) {
          fs.writeFileSync(
            path.join(backupDir, `${opts.projectId}.thesaurus.json.bak-${ts}`),
            lv2Raw, 'utf8'
          );
        }

        // Guard WEB-032 (adapté Niveau 2) — déduplication Pending JSON.
        // Ne pas réinsérer si une entrée pending pour le même terme existe déjà
        // dans lv2Data.pending (import non retiré, annulation double, etc.).
        const _pendingArr = lv2Data.pending || [];
        const _slotPfx2   = proposed ? proposed.split(':')[0].trim() : '';
        const _dupExists2  = _pendingArr.some(p =>
          p.term === term && p.source_import === sourceImport &&
          (p.proposed_mapping || '').split(':')[0].trim() === _slotPfx2
        );

        // Supprimer des aliases + ajouter en pending — tout dans le même JSON.
        if (teIdx >= 0) teArr.splice(teIdx, 1);
        if (svIdx >= 0) svArr.splice(svIdx, 1);
        if (!_dupExists2) {
          _pendingArr.push({
            term,
            proposed_mapping: proposed,
            flag:         '⚠️ _a_confirmer',
            source_import: sourceImport,
            note:         `unconfirmed via chorus-web ${new Date().toISOString().slice(0, 10)}`,
          });
        }
        lv2Data.pending = _pendingArr;
        if (!lv2Data._meta) lv2Data._meta = {};
        lv2Data._meta.updated = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(lv2Path, JSON.stringify(lv2Data, null, 2), 'utf8');

        // Journal (best-effort)
        try {
          _appendThesaurusLog(sbPath, opts.entityId, opts.projectId, opts.projectName, {
            date: new Date().toISOString().slice(0, 10),
            term, action: '↩️ Annulé Projet (retour en Pending)',
            typeElement, slot, value, shard, sourceImport,
          });
        } catch { /* non-bloquant */ }

        const driftedElements = _detectProjectJsonDrift(sbPath, opts.entityId, opts.projectId, term);
        return { ok: true, shard, scope: shard, level: 2, driftedElements };
      }
    }
  }

  // ── Niveau 3 / legacy — workspace/<entity>/thesaurus.org ou agent/thesaurus/ ──
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

  // 2) ⛔ Garde-fou STRUCTUREL : cette branche traite exclusivement des lignes
  // vivant dans workspace/<entity>/thesaurus.org § Aliases — c'est-à-dire,
  // par construction du fichier lui-même, des mappings Niveau 3 (entity-wide).
  // Refuser systématiquement, QUEL QUE SOIT le texte de la colonne confidence.
  //
  // Avant ce correctif, le refus se basait sur un parsing texte (regex
  // "validated via chorus-web" + regex "entity-promoted") — fragile car une
  // ligne peut très bien vivre dans thesaurus.org avec un texte confidence
  // générique "✅ confirmed (validated via chorus-web <date>)" (sans le
  // suffixe "entity-promoted"), par exemple si elle y a été écrite par une
  // autre voie que le bouton 🏢 (édition manuelle du fichier, import legacy,
  // migration WEB-027...). Le garde-fou texte laissait alors passer
  // l'annulation d'une ligne pourtant bien entity-wide. (Incident : sandbox
  // 08-ANSSI-PG-083-CENTRIC, entity eviden, 5 lignes "CKM_RSA_AES_KEY_WRAP" /
  // "*Hybrid KEM" — confidence="✅ confirmed (validated via chorus-web
  // 2026-11-10)", level=3 réel, bouton ↩️ Annuler affiché à tort côté UI et
  // accepté à tort côté serveur avant ce correctif.)
  const confidenceCol = found.kind === 'type_element' ? found.cells[2] : found.cells[3];
  throw new Error(
    `Alias vivant dans ${shard}.org § Aliases (Niveau 3 — entity-wide) — annulation non ` +
    `autorisée depuis la webapp, quel que soit le texte de confidence ("${confidenceCol}"). ` +
    `Une entrée Niveau 3 ne peut être révisée que via un ré-import.`
  );
}

module.exports = { scanSandboxThesaurus, resolveThesaurusPending, unconfirmThesaurusAlias };
