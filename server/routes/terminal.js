/**
 * server/routes/terminal.js — Terminal ECA interactif (SSE)
 *
 *   GET    /api/terminals/active
 *   POST   /api/sandboxes/:sbId/terminal
 *   POST   /api/sandboxes/:sbId/terminal/respond
 *   POST   /api/sandboxes/:sbId/terminal/stop
 *   DELETE /api/sandboxes/:sbId/terminal
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Router } = require('express');
const chorus = require('../../chorus');
const eca    = require('../../eca-client');
const { sseInit, sseSend, sseDone, sseError } = require('../helpers/sse');
const { activeTerminals } = require('../state');

const router = Router();

// ── Mapping skill/trigger → agent ECA attendu (Engine/TODO.org [#J] Axe 1)
// Miroir de la table Trigger → Skill → Agent documentée dans
// Engine/AGENTS.md § "Triggers and skills". Détection par mot-clé dans le
// message envoyé — volontairement simple (regex sur le nom du
// trigger/skill tel qu'il apparaît typiquement dans les commandes
// générées par l'UI, ex. "chorus-check sbId --summary") plutôt qu'un
// parsing structurel : les boutons UI envoient des commandes textuelles
// prévisibles (cf. chorus-web.js § ecaShowCmd), donc un matching simple
// suffit et reste facile à maintenir en miroir d'AGENTS.md.
// Ordre : du plus spécifique au plus générique — le premier match gagne.
const AGENT_BY_TRIGGER = [
  // architect — skills de modélisation/décision lourde
  { pattern: /\bchorus-(feed|pdf|word|excel|corpus-directives|corpus-scoping|check|schema-export|create-project|stress|strengthen|review-kb|showcase|complete-report)\b/, agent: 'architect' },
  { pattern: /\b(deep-cms6|deep-cms5|deep-otc|map-cms5|map-otc|warmup-cms5-mig|study-cms5|study-cms6|analyze-main|update-knowledge|review-adr|review-mr|review-branch|review-br|test-mr|fix-mr|inspect-branch|test-branch|test-br|report-ticket)\b/, agent: 'architect' },
  { pattern: /\btest-skborg\b/, agent: 'fast' },
  // fast — consultation/lecture seule
  { pattern: /\b(chorus-quickstart|prepare-ticket|prepare\s+NEWT|git-ctx|skills(\s+details)?|tag-rdiff)\b/, agent: 'fast' },
  // code — édition standard
  { pattern: /\bchorus-(import-project|audit-import)\b/, agent: 'code' },
  { pattern: /\b(select-mr|publish-review|inspect-mr|create-mr|cpan-release)\b/, agent: 'code' },
];

/** Déduit l'agent ECA attendu depuis le texte du message utilisateur, ou
 * null si aucun trigger connu n'est détecté (laisse alors l'agent du chat
 * inchangé — ne force rien pour les messages en langage naturel libre). */
function detectExpectedAgent(message) {
  for (const { pattern, agent } of AGENT_BY_TRIGGER) {
    if (pattern.test(message)) return agent;
  }
  return null;
}

// ── GET /api/terminals/active ─────────────────────────────────────────────
router.get('/terminals/active', (req, res) => {
  const sessions = Array.from(activeTerminals.entries()).map(([sessionId, t]) => ({
    sessionId,
    sbId:        t.sbId,
    level:       t.level,
    entityId:    t.entityId || null,
    projId:      t.projId || null,
    reportFile:  t.reportFile || null,
    kind:        t.kind || null,
    startedAt:   t.startedAt || null,
    elapsedMs:   t.startedAt ? Date.now() - t.startedAt : null,
    lastMessage: t.lastMessage || null,
  }));
  res.json({ ok: true, count: sessions.length, sessions });
});

// ── POST /api/sandboxes/:sbId/terminal ───────────────────────────────────
router.post('/sandboxes/:sbId/terminal', (req, res) => {
  const { sbId } = req.params;
  const { level, entityId, projId, reportFile, sessionId, message, timeoutMinutes, kind } = req.body;

  if (!message || !sessionId) { sseInit(res); return sseError(res, 'message/sessionId manquant'); }
  if (!['sandbox', 'entity', 'project', 'report'].includes(level)) {
    sseInit(res); return sseError(res, `level invalide : ${level}`);
  }

  // ── Garde de concurrence — chorus-strengthen / chorus-stress ─────────
  // Ces commandes peuvent être très chronophages, produire des boucles
  // infinies côté Perl et faire grimper le CPU à 99% (cf. Engine/AGENTS.md
  // et retour utilisateur) — on interdit catégoriquement plus d'une session
  // de ce type active simultanément sur un même sandbox, avant même de
  // contacter eca-server. `kind` est fourni explicitement par le bouton
  // dédié de l'onglet TESTS (jamais déduit du texte libre — un utilisateur
  // tapant "lance chorus-strengthen" dans un terminal normal n'est pas
  // bloqué ici, seule la UI "Renforcer" de l'onglet TESTS positionne ce flag).
  if (kind === 'strengthen') {
    const already = [...activeTerminals.values()]
      .find(t => t.sbId === sbId && t.kind === 'strengthen');
    if (already) {
      sseInit(res);
      return sseError(
        res,
        `Un chorus-strengthen est déjà en cours sur ce sandbox depuis ` +
        `${Math.round((Date.now() - (already.startedAt || Date.now())) / 60000)} min — ` +
        `attendez sa fin avant d'en relancer un (risque CPU élevé en cas d'exécution concurrente).`
      );
    }
  }

  // ── Garde de concurrence — chorus-fix ──────────────────────────────
  // chorus-fix peut modifier des fichiers YAML et déclencher chorus-feed
  // --enrich (bucket-c) — interdit d'en avoir deux simultanément sur le même
  // sandbox (risque de conflits d'écriture et de rapports de gaps incohérents).
  if (kind === 'fix') {
    const already = [...activeTerminals.values()]
      .find(t => t.sbId === sbId && (t.kind === 'fix' || t.kind === 'strengthen'));
    if (already) {
      sseInit(res);
      return sseError(
        res,
        `Un ${already.kind === 'fix' ? 'chorus-fix' : 'chorus-strengthen'} est déjà en cours sur ce sandbox — ` +
        `attendez sa fin avant de lancer chorus-fix (risque de conflits sur les fichiers YAML).`
      );
    }
  }

  sseInit(res);
  // Timeout configurable (panneau Config § ECA Server, défaut 60 min côté
  // frontend — voir chorus-web.js § SETTINGS.eca.terminalTimeoutMinutes).
  // Borné ici indépendamment du frontend par sécurité (1 min .. 4h) en cas
  // de valeur corrompue/absente transmise par un client plus ancien.
  // Les sessions `kind: 'strengthen'` utilisent un plafond réduit (45 min
  // par défaut au lieu de 60) pour limiter l'exposition en cas de boucle
  // infinie côté pipeline Perl — toujours modifiable explicitement par le
  // frontend via timeoutMinutes, jamais silencieusement étendu au-delà.
  // chorus-fix (bucket-b seul) est rapide ; --bucket-c peut déclencher
  // chorus-feed --enrich qui est long → timeout intermédiaire 30 min.
  // pipeline-feed : enchaîne corpus-directives → corpus-scoping → feed
  // --unattended — peut être très long sur un grand corpus multi-sources.
  const DEFAULT_TIMEOUT_MINUTES = kind === 'strengthen' ? 45
    : kind === 'fix'           ? 30
    : kind === 'pipeline-feed' ? 120
    : 60;
  let timeoutMs = Number(timeoutMinutes);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) timeoutMs = DEFAULT_TIMEOUT_MINUTES;
  if (timeoutMs > 240) timeoutMs = 240;
  timeoutMs = timeoutMs * 60_000;

  (async () => {
    // ── Context block ──────────────────────────────────────────────────
    let contextBlock = '';
    try {
      const sb = chorus.scanSandbox(sbId);
      if (level === 'sandbox') {
        contextBlock = `Sandbox ${sbId} — norme ${sb.norm}. Entities : ${sb.entities.map(e => e.id).join(', ') || '(aucune)'}.`;
      } else if (level === 'entity') {
        const entity = sb.entities.find(e => e.id === entityId);
        const projs  = (entity && entity.projects) || [];
        contextBlock = `Entity ${entityId} (sandbox ${sbId}) — projets : ${projs.map(p => p.id).join(', ') || '(aucun)'}.`;
      } else if (level === 'project') {
        const entity = sb.entities.find(e => e.id === entityId);
        const proj   = entity && (entity.projects || []).find(p => p.id === projId);
        contextBlock = `Projet ${projId} (${sbId}/${entityId}) — ${proj ? `${proj.frames || 0} frames, verdict ${proj.verdict || '?'}` : '(détails indisponibles)'}.`;
      } else if (level === 'report') {
        const content = chorus.readReport(sbId, entityId, projId, reportFile) || '';
        contextBlock = `Rapport ${reportFile} (${sbId}/${entityId}/${projId}) :\n${content.slice(0, 8000)}`;
      }

      // ── Enrichissement pipeline-feed : injection des instructions ────────
      // Si instructions-directives.md ou instructions-scoping.md existent à
      // la racine du sandbox, on les injecte dans le contextBlock afin que
      // le skill chorus-corpus-directives / chorus-corpus-scoping les lise
      // directement depuis le prompt (pré-remplit les 4+5 questions sans
      // interaction). Uniquement pour kind === 'pipeline-feed' pour éviter
      // d'alourdir tous les autres terminaux sandbox.
      if (kind === 'pipeline-feed') {
        const sbPath     = sb.path;
        const instrDir   = path.join(sbPath, 'instructions-directives.md');
        const instrScope = path.join(sbPath, 'instructions-scoping.md');
        if (fs.existsSync(instrDir)) {
          const content = fs.readFileSync(instrDir, 'utf8');
          contextBlock += `\n\n[instructions-directives.md — réponses pré-remplies aux 4 questions chorus-corpus-directives]\n${content}`;
        }
        if (fs.existsSync(instrScope)) {
          const content = fs.readFileSync(instrScope, 'utf8');
          contextBlock += `\n\n[instructions-scoping.md — réponses pré-remplies aux 5 questions chorus-corpus-scoping]\n${content}`;
        }
      }

      // ── Enrichissement spécialisé pour chorus-strengthen / chorus-fix ──
      // Injecte les données déjà lues par scanSandbox() (convergence, rapport
      // de gaps) pour éviter que l'agent ECA reparte de zéro. Ajouté en
      // complément du contextBlock de base (pas en remplacement).
      if (kind === 'strengthen' || kind === 'fix') {
        const sbPath  = sb.path;
        const lcr     = chorus.readLastCheckResults(sbPath);
        const lsr     = chorus.readLastStrengthenReport(sbPath);
        const testing = sb.testing || {};

        // ── Convergence summary (from .last-check-results.json) ──────────
        const STRATEGIES = ['iso', 'edges', 'cross', 'scale'];
        const convergenceLines = STRATEGIES
          .filter(s => testing[s])
          .map(s => {
            const entry = testing[s];
            const cv    = entry.convergence;
            if (!cv) return `  ${entry.file}: jamais exécuté en mode --all`;
            const disc = cv.discordances || 0;
            const unp  = cv.unprocessed  || 0;
            const st   = cv.stale ? ' [STALE]' : '';
            const ok   = disc === 0 && unp === 0 ? '✅' : '⚠️';
            return `  ${ok} ${entry.file}: ${disc} discordance(s), ${unp} unprocessed${st}`;
          });

        let extra = '';

        if (convergenceLines.length) {
          extra += `\n\nÉtat de convergence (source: .last-check-results.json):\n${convergenceLines.join('\n')}`;
          if (lcr?.stale) extra += `\n  ⚠️ Résultats périmés — KB modifiée depuis le dernier chorus-check --all.`;
        } else {
          extra += `\n\nAucun fichier project-*.json trouvé — lancez chorus-create-project --batch d'abord.`;
        }

        // ── Gap report summary (from .last-strengthen-report.json) ───────
        if (kind === 'fix') {
          if (!lsr) {
            extra += `\n\nRapport chorus-strengthen : absent — lancez chorus-strengthen ${sbId} avant chorus-fix.`;
          } else if (lsr.stale) {
            extra += `\n\nRapport chorus-strengthen : PÉRIMÉ (KB modifiée depuis). Relancez chorus-strengthen avant chorus-fix.`;
          } else {
            const { bucket_b = 0, bucket_c = 0, bucket_a = 0 } = lsr.summary || {};
            extra += `\n\nRapport chorus-strengthen (${lsr.timestamp?.slice(0, 16) || '?'}):\n`;
            extra += `  Total gaps : ${lsr.totalGaps}  (B:${bucket_b} C:${bucket_c} A:${bucket_a})\n`;
            if (lsr.gaps?.length) {
              extra += `  Gaps détaillés :\n`;
              for (const g of lsr.gaps) {
                const blocked = g.blocked ? ' [BLOQUÉ — garde anti-régression]' : '';
                extra += `  #${g.id} [${g.bucket}] ${g.gap_type} · ${g.element_id} · règle: ${g.rule_file || '—'} · agent: ${g.agent || '—'}${blocked}\n`;
                if (g.hypothesis) extra += `     Hypothèse: ${g.hypothesis}\n`;
                if (g.corpus_ref && g.corpus_ref !== 'null') extra += `     Réf corpus: ${g.corpus_ref}\n`;
              }
            }
          }
        } else {
          // strengthen : indiquer si un rapport existe déjà (évite une relance inutile)
          if (lsr && !lsr.stale && lsr.totalGaps > 0) {
            const { bucket_b = 0, bucket_c = 0, bucket_a = 0 } = lsr.summary || {};
            extra += `\n\nDernier rapport strengthen (${lsr.timestamp?.slice(0, 16) || '?'}): ${lsr.totalGaps} gap(s) (B:${bucket_b} C:${bucket_c} A:${bucket_a}) — toujours valide si la KB n'a pas changé.`;
          }
        }

        contextBlock += extra;
      }
      // ── Enrichissement thesaurus-assistant ─────────────────────────────
      // Injecte le contenu actuel du thésaurus entity + les entrées _a_confirmer
      // du JSON projet, afin que le LLM ait le contexte complet sans avoir à lire
      // les fichiers lui-même avant le premier eca__ask_user.
      if (kind === 'thesaurus-assistant' && entityId && projId) {
        try {
          const sbPath   = path.join(chorus.SANDBOXES_DIR(), sbId);
          const thesFile = path.join(sbPath, 'workspace', entityId, 'thesaurus.org');
          const thesContent = fs.readFileSync(thesFile, 'utf8');
          // Limiter à 3 000 chars pour ne pas saturer le contexte
          contextBlock += `\n\nContenu actuel du thésaurus (${thesFile}) :\n${thesContent.slice(0, 3000)}`;
        } catch { /* thésaurus absent — le LLM le détectera */ }

        try {
          const sbPath  = path.join(chorus.SANDBOXES_DIR(), sbId);
          const projFile = path.join(sbPath, 'workspace', entityId, `${projId}.json`);
          const projData = JSON.parse(fs.readFileSync(projFile, 'utf8'));
          const aConf = projData._import?.a_confirmer || [];
          if (aConf.length) {
            contextBlock += `\n\nÉléments _a_confirmer dans ${projId}.json (${aConf.length}) :\n` +
              aConf.map(a => `  • ${a.slice(0, 150)}`).join('\n');
          }
        } catch { /* JSON absent ou invalide */ }
      }

    } catch (e) { contextBlock = `(contexte indisponible : ${e.message})`; }

    // ── chatId isolé par sessionId ─────────────────────────────────────
    const chatId = `eca-term-${sbId}-${sessionId}`;
    let agentsPrefix = '';
    let chatAlreadyExists = false;
    const chorusHome = chorus.CHORUS_HOME();
    try {
      const list  = await eca.ecaRequest('/api/v1/chats', 'GET');
      chatAlreadyExists = Array.isArray(list) && !!list.find(c => c.id === chatId);
      if (!chatAlreadyExists) {
        agentsPrefix =
          `[Chorus ECA Terminal — sandbox: ${sbId}]\n` +
          `Workspace: ${chorusHome}. ` +
          `Engine AGENTS.md: ${path.join(chorusHome, 'engine', 'AGENTS.md')}. ` +
          `Read it via your tools when needed to answer Chorus commands.\n\n`;
      }
    } catch { /* proceed without prefix */ }

    // ── Directive skill — chargement explicite pour les commandes Chorus connues ──
    // ECA reçoit seulement le chemin de l'AGENTS.md, qu'il peut ne pas lire s'il
    // connaît la commande de son entraînement. Sans eca__read_file() sur le skill,
    // nos améliorations (Phase 0-bis/2.0-bis/4-checkpoint, eca__task, eca__ask_user)
    // sont ignorées. Solution : injecter une directive explicite pour forcer le
    // chargement du skill depuis le disque (version à jour).
    // ⛔ eca__skill() est interdit pour les skills Chorus (non enregistrés dans
    // eca-config.json — toujours KO) — utiliser eca__read_file() uniquement.
    const CHORUS_SKILL_MAP = {
      strengthen:            'chorus-strengthen',
      fix:                   'chorus-fix',
      'thesaurus-assistant': 'thesaurus-assistant', // court-circuite la détection regex
      // les autres kinds n'ont pas de skill dédié ou sont gérés par le message lui-même
    };
    // Pour tout message contenant un déclencheur Chorus connu, forcer eca__read_file
    const knownSkillPatterns = [
      { re: /\bchorus-strengthen\b/,     skill: 'chorus-strengthen'     },
      { re: /\bchorus-check\b/,          skill: 'chorus-check'          },
      { re: /\bchorus-feed\b/,           skill: 'chorus-feed'           },
      { re: /\bchorus-create-project\b/, skill: 'chorus-create-project' },
      { re: /\bchorus-fix\b/,            skill: 'chorus-fix'            },
      { re: /\bchorus-stress\b/,         skill: 'chorus-stress'         },
      // chorus-import-project : force skill load pour la logique _a_confirmer
      // (3 tiers — voir chorus-import-project.md § "_a_confirmer resolution")
      { re: /\bchorus-import-project\b/, skill: 'chorus-import-project' },
    ];
    const detectedSkill = (() => {
      if (CHORUS_SKILL_MAP[kind]) return CHORUS_SKILL_MAP[kind];
      for (const { re, skill } of knownSkillPatterns) {
        if (re.test(message)) return skill;
      }
      return null;
    })();

    // ── Directive skill — injection des instructions critiques ──────────
    // La simple invite à charger le skill est insuffisante : ECA peut l'ignorer
    // et exécuter la commande depuis son entraînement (comportement observé :
    // scan de tous les run-report-*.json au lieu de lire .last-check-results.json).
    // Solution : injecter les règles critiques directement dans le contexte.
    const SKILL_CRITICAL_RULES = {
      'chorus-strengthen': [
        '⛔ NE JAMAIS scanner les fichiers run-report-*.json individuels — ils contiennent des données brutes potentiellement obsolètes.',
        '✅ Phase 1.1 OBLIGATOIRE en premier : lire $SANDBOX/.last-check-results.json pour le cache (kb_hash + proj_hash).',
        '✅ Si cache HIT (les deux hashes correspondent) : utiliser ces résultats DIRECTEMENT, NE PAS relancer chorus-check.',
        '✅ Si cache MISS seulement : spawner des sous-agents via eca__spawn_agent pour chorus-check --all.',
        '✅ Phase 0-bis : appeler eca__task(op="plan",...) pour afficher le taskboard de progression.',
        '✅ Phase 2.0-bis : détecter les bugs C2-C5 dans les fichiers projet avant de classer comme gaps KB.',
        '✅ Phase 4-checkpoint : appeler eca__ask_user() pour valider les hypothèses avant Phase 4.5.',
      ],
      'chorus-check': [
        '✅ Mode --all : spawner un sous-agent par project-*.json via eca__spawn_agent.',
        '✅ Phase 6.3 (mono-projet) : mettre à jour .last-check-results.json après chaque run.',
        '✅ Phase 6-all.0-bis : appeler eca__task(op="plan",...) pour le taskboard.',
      ],
      'chorus-create-project': [
        '✅ Phase 6.2 step 5 : mettre à jour .last-check-results.json avec proj_hash path-indépendant.',
        '✅ proj_hash = sha256sum project-*.json | awk \'{print $1}\' | sha256sum (PAS sha256sum|sha256sum direct).',
      ],
      'chorus-feed': [
        '✅ § 0-bis : appeler eca__task(op="plan",...) pour le taskboard au démarrage.',
      ],
      'thesaurus-assistant': [
        '✅ INTERACTIVE MODE — eca__ask_user EST DISPONIBLE et OBLIGATOIRE pour chaque terme Pending.',
        '✅ Pour chaque terme : analyser → formuler une recommandation avec justification → appeler eca__ask_user avec les options [✅ Confirmer] [❌ Rejeter] [⬜ Hors périmètre].',
        '✅ Après chaque décision utilisateur : mettre à jour immédiatement thesaurus.org via eca__edit_file.',
        '✅ Ne passer au terme suivant qu\'après confirmation de l\'écriture.',
        '⛔ Ne jamais traiter les termes en batch silencieux — chaque terme requiert une décision utilisateur explicite.',
        '⛔ Après écriture dans * Aliases : OBLIGATOIRE supprimer la ligne correspondante dans * Pending dans le MÊME appel eca__edit_file (ou dans un 2e appel immédiat). Ne jamais laisser la même entrée dans les deux sections — incohérence silencieuse dans la webapp.',
        '⛔ confidence dans * Aliases DOIT être "✅ confirmed (validated via chorus-web YYYY-MM-DD)" — jamais "confirmed (conservative)" ni autre variante libre. Format exact requis pour affichage ✍️ Manuel dans la webapp.',
        '⛔ Ne jamais appeler chorus-import-project avant que toutes les décisions soient prises.',
        '⛔ Ne pas promouvoir à l\'entity (🏢) sauf demande explicite de l\'utilisateur.',
      ],
      'chorus-import-project': [
        '✅ Appeler eca__task(op="plan",...) en Phase 0 pour afficher la progression des phases dans le bandeau.',
        '⛔ Phase 1.3 (previous alignment decisions) : SKIP si workspace/<C>/thesaurus.org existe — les décisions cross-import légitimes sont DÉJÀ dans le thésaurus Niveau 3. Lire un import-report précédent viole WEB-027 (reproduit des décisions Niveau 2 non promues).',
        '⛔ Phase 2 (inventaire brut) : ne JAMAIS lire de fichier <slug>.org — inventaire brut uniquement, zéro lookup KB, zéro lecture thésaurus.',
        '⛔ Les fichiers <slug>.org sont chargés UNIQUEMENT en Phase 3, la première fois qu\'un terme nécessite cet agent (lazy loading WEB-029).',
        '✅ _a_confirmer résolution AUTONOME (3 tiers) — lire § "_a_confirmer resolution — three tiers" du skill OBLIGATOIREMENT avant toute résolution.',
        '✅ Obvious tier : appliquer DIRECTEMENT et SILENCIEUSEMENT sans eca__ask_user — une seule ligne dans l\'alignment table par terme (format : "terme → type_element | ✅ OID/RFC"), zéro raisonnement narratif par terme. Traiter tous les termes Obvious en une seule passe batch.',
        '✅ Ambiguous tier : NE PAS bloquer — conserver _a_confirmer:1, jamais promouvoir vers ✅ sans décision explicite ingénieur.',
        '✅ Unresolvable tier : gap structurel → jamais auto-résolu → _a_confirmer:1.',
        '⛔ Ne jamais appeler eca__ask_user — AUTONOMOUS_MODE actif sur cette branche (pas de WEB-025).',
        '⛔ Ne jamais promouvoir un ⚠️ Pending vers ✅ Aliases automatiquement (sauf si déjà ✅ dans le thésaurus existant).',
        '⛔ KB gap ≠ _a_confirmer : si le type_element est reconnu mais absent de la KB (ex. Argon2id) → classer dans gaps (_import.gaps) UNIQUEMENT, jamais _a_confirmer. _a_confirmer = interprétations KB concurrentes. gap = KB ne couvre pas encore cet algorithme.',
        '⛔ Post-import audit obligatoire : après chorus-audit-import, écrire le bloc _audit dans le JSON produit (run, date, report, gaps_comblables, gaps_partiels, gaps_absents, gaps_mapping, frames_manquantes, patch_applied). Ne JAMAIS se contenter d\'écrire uniquement le rapport .md sans patcher le JSON.',
        '⛔ _audit OBLIGATOIREMENT à la RACINE du JSON — jamais imbriqué dans _import. Structure correcte : {"project":…,"_import":{…},"_audit":{…},"elements":[…]}. _import._audit est silencieusement ignoré par le scanner webapp → onglets vides.',
        '⛔ _import.import_report OBLIGATOIRE — pointer vers le fichier import-report-NNN.org produit (ex: "workspace/<C>/reports/import-report-001.org"). Si absent → onglet Imports vide dans la webapp.',
        '⛔ import-report-NNN.org DOIT contenir #+DATE: YYYY-MM-DD ET #+OUTPUT_JSON: workspace/<C>/project-import-<ID>.json — sans ces deux headers le scanner ne peut pas associer le rapport au projet → onglet Imports vide.',
        '⛔ import-report-NNN.org — #+SOURCE: DOIT être un chemin de fichier valide (ex: workspace/<C>/sources/<fichier>-text.md), jamais une description libre ("fusion N fichiers", etc.). En mode Merge/Fusion : utiliser le PREMIER fichier source de la liste. Un #+SOURCE: non-chemin donne sourceBasename invalide → thésaurus filtré → onglet Thésaurus vide.',
        '⛔ _import.source (ou _import.source_file) DOIT être renseigné même en mode Merge — mettre le premier fichier source de la liste. Si absent, le scanner ne peut pas calculer sourceBasename → thésaurus invisible.',
      ],
    };

    const skillDirective = detectedSkill
      ? (() => {
          const rules = SKILL_CRITICAL_RULES[detectedSkill] || [];
          const rulesBlock = rules.length
            ? '\nRègles critiques à respecter impérativement :\n' + rules.map(r => `  ${r}`).join('\n')
            : '';
          const skillPath = path.join(chorusHome, 'engine', 'agent', 'skills', `${detectedSkill}.md`);
          const skillExists = fs.existsSync(skillPath);
          if (!skillExists) {
            // Pas de fichier skill sur disque — injecter les règles directement
            // sans directive eca__read_file pour éviter un warning "fichier introuvable".
            return rules.length
              ? `\n\n[Protocole ${detectedSkill}]${rulesBlock}`
              : '';
          }
          return `\n\n[SKILL OBLIGATOIRE — à exécuter EN PREMIER, avant tout autre outil]\n` +
            `Charge le skill via : eca__read_file("${skillPath}")${rulesBlock}\n` +
            `⛔ NE commence JAMAIS à exécuter sans avoir d'abord chargé son skill — le skill contient les instructions à jour.`;
        })()
      : '';

    // WEB-025b — Fix A : DONE_INSTRUCTION adaptée au kind interactif.
    // Pour thesaurus-assistant (multi-tours eca__ask_user), interdire
    // explicitement d'écrire DONE entre deux ask_user individuels.
    // C'est la cause racine identifiée (2026-11) : ECA interprétait
    // "question répondue" comme une condition de fin globale et écrivait
    // DONE après chaque terme, ce qui fermait la session prématurément.
    const DONE_INSTRUCTION = kind === 'thesaurus-assistant'
      ? '\n\n[TERMINAL PROTOCOL — SESSION INTERACTIVE THÉSAURUS — STRICT]\n' +
        'Après chaque décision utilisateur via eca__ask_user, DEUX CAS POSSIBLES :\n' +
        '\n' +
        'CAS A — l\'utilisateur a choisi ✅ Confirmer / ❌ Rejeter / ⬜ Hors périmètre :\n' +
        '  1. Appelle eca__edit_file — UN SEUL appel qui fait LES DEUX simultanément :\n' +
        '     • ajoute le terme dans la section appropriée (* Aliases pour confirmer, * Out-of-scope pour hors périmètre)\n' +
        '     • supprime le terme de * Pending (même appel, même original_content/new_content)\n' +
        '     • si rejeté sans reclassement : supprime simplement la ligne de * Pending\n' +
        '  2. IMMÉDIATEMENT après le résultat de eca__edit_file, dans le MÊME tour de génération :\n' +
        '     • si tu avais d\'autres termes Pending à traiter → appelle eca__ask_user pour le suivant\n' +
        '     • si c\'était le dernier terme → écris uniquement "DONE" sur la dernière ligne et arrête-toi\n' +
        '\n' +
        'CAS B — l\'utilisateur a choisi ⏭️ Passer (réponse littérale "passer") :\n' +
        '  ⛔ N\'appelle AUCUN eca__edit_file pour ce terme — laisse-le inchangé dans * Pending.\n' +
        '  IMMÉDIATEMENT, dans le MÊME tour de génération :\n' +
        '     • si tu avais d\'autres termes Pending à traiter → appelle eca__ask_user pour le suivant\n' +
        '     • si c\'était le dernier terme → écris uniquement "DONE" sur la dernière ligne et arrête-toi\n' +
        '⛔ NE PAS appeler eca__read_file après eca__edit_file — tu sais combien de termes restent.\n' +
        '⛔ NE PAS générer de texte entre les étapes, dans AUCUN des deux cas.\n' +
        '⛔ NE PAS faire deux appels eca__edit_file séparés (un pour Aliases, un pour Pending).'
      : '\n\n[TERMINAL PROTOCOL — OBLIGATOIRE] ' +
        'Quand ta réponse est entièrement terminée — skill accompli, fichiers écrits, question répondue — ' +
        'tu dois écrire en toute dernière ligne, seule sur sa ligne, le mot exactement : DONE';

    const fullMessage =
      `${agentsPrefix}[Contexte ECA — niveau ${level}]\n${contextBlock}\n\nQuestion : ${message}` +
      skillDirective +
      DONE_INSTRUCTION;

    // ── Subscribe BEFORE sending ─────────────────────────────────────────
    let subReq = null, finished = false;
    // ── Guard eca__ask_user — WEB-025 ─────────────────────────────────────
    // When ECA calls eca__ask_user the chat status briefly goes 'idle' while
    // waiting for the user's answer, which would trigger onDone → finish()
    // and close the SSE stream before the user has responded.
    // Fix: set waitingForUserInput = true in onAsk, clear it in /respond,
    // and guard both onDone and the timeout against premature closure.
    let waitingForUserInput = false;
    let pendingTimeoutRestart = null; // stores remaining ms to restart timeout after respond
    let gracePeriodHandle    = null;  // grace period 3s après réponse utilisateur
    // WEB-025b — Fix B : deferred close post-ask_user response.
    // Après que l'utilisateur a répondu à un ask_user, ECA reprend et peut
    // terminer son tour (écrire DONE, aller idle) AVANT d'appeler le prochain
    // ask_user (s'il en reste). clearAskGuard() lève waitingForUserInput dès
    // le premier chunk — sans protection, l'idle de fin de tour ferme la session.
    //
    // Design corrigé (v2) : le timer de 8s démarre depuis onDone (quand ECA
    // passe réellement à idle), PAS depuis clearAskWait (quand l'utilisateur
    // répond). Si ECA met 30s à écrire dans le thésaurus avant d'appeler le
    // prochain ask_user, le timer ne démarre qu'une fois cet idle reçu.
    //
    // postRespondPending = true  : l'utilisateur a répondu à un ask_user ;
    //                              le prochain idle dans onDone arme le timer.
    // deferredDoneHandle         : setTimeout(8s) armé depuis onDone ;
    //                              annulé par onAsk si un autre ask_user arrive.
    let postRespondPending   = false; // WEB-025b: en attente d'un idle post-réponse
    let deferredDoneHandle   = null;  // WEB-025b: close différé 8s depuis idle
    // Fix (sur-déclenchement fermeture/relance) — compteur de Pending restants
    // au dernier edit_file traité sur thesaurus.org. Évite qu'un ECA qui
    // appellerait eca__edit_file plusieurs fois pour une même décision
    // (relecture, édition en 2 temps, etc. — hors protocole strict demandé
    // mais non garanti) ne déclenche plusieurs fermetures/relances de
    // terminal pour un seul cycle de décision réellement abouti. null tant
    // qu'aucun edit_file thésaurus n'a encore été vu dans cette session.
    let lastKnownPendingCount = null;
    // Helper : ECA a repris (chunk ou toolLog) → lever le guard immédiatement
    const _dbg = (...a) => console.log(`[WEB-025][${sessionId}]`, ...a);
    const clearAskGuard = () => {
      if (gracePeriodHandle) { clearTimeout(gracePeriodHandle); gracePeriodHandle = null; }
      waitingForUserInput = false;
    };

    const heartbeat = setInterval(() => {
      if (!finished) sseSend(res, 'ping', { t: Date.now() });
    }, 15000);

    const finish = (errMsg) => {
      if (finished) return;
      finished = true;
      activeTerminals.delete(sessionId);
      clearInterval(heartbeat);
      if (pendingTimeoutRestart) { clearTimeout(pendingTimeoutRestart); pendingTimeoutRestart = null; }
      if (gracePeriodHandle)    { clearTimeout(gracePeriodHandle);    gracePeriodHandle    = null; }
      if (deferredDoneHandle)   { clearTimeout(deferredDoneHandle);   deferredDoneHandle   = null; }
      if (subReq) { try { subReq.destroy(); } catch {} }
      if (errMsg) sseError(res, errMsg);
      else sseDone(res, {});
    };

    let timeoutHandle = setTimeout(
      () => {
        if (waitingForUserInput) {
          // User hasn't answered yet — extend by the full configured timeout
          // rather than closing the session mid-question.
          pendingTimeoutRestart = setTimeout(
            () => finish(`timeout après attente réponse utilisateur (${Math.round(timeoutMs / 60_000)} min supplémentaires)`),
            timeoutMs
          );
        } else {
          finish(`timeout après ${Math.round(timeoutMs / 60_000)} min — skill encore en cours côté ECA`);
        }
      },
      timeoutMs
    );

    const { req: sReq, done } = eca.subscribeEcaEvents(chatId, {
      onChunk:   (text)     => {
        clearAskGuard(); // ECA a repris — lever le guard immédiatement
        if (!finished) sseSend(res, 'chunk', { text });
      },
      onAsk:     (payload)  => {
        if (!finished) {
          postRespondPending = false;
          if (deferredDoneHandle) { clearTimeout(deferredDoneHandle); deferredDoneHandle = null; }
          waitingForUserInput = true;
          sseSend(res, 'ask', payload);
        }
      },
      onToolLog: (toolInfo) => {
        clearAskGuard(); // ECA a repris — lever le guard immédiatement
        if (finished) return;
        sseSend(res, 'tool', toolInfo);

        // WEB-025d — Thesaurus-assistant proactive close.
        // ECA a un bug systématique : après toolCalled(edit_file) dans le
        // contexte d'une réponse ask_user, le second appel LLM (continuation)
        // ne démarre jamais → session bloquée indéfiniment. Workaround :
        // si l'edit_file sur thesaurus.org a réussi ET que * Pending est
        // désormais vide, fermer la session proactivement côté webapp
        // sans attendre le chat:status-changed:idle d'ECA.
        //
        // ⛔ Fix (race condition intermittente, constatée empiriquement :
        // auto-restart fonctionne "à plusieurs reprises" puis se bloque sans
        // raison apparente) — ce check dépendait de `postRespondPending`,
        // un flag consommé par le tout premier `onDone` (idle) reçu après la
        // réponse utilisateur (voir onDone plus bas). Or ECA peut émettre un
        // idle TRANSITOIRE avant d'exécuter effectivement le edit_file (pause
        // interne entre la réponse à ask_user et l'appel d'outil réel) — si
        // cet idle arrive en premier, postRespondPending passe à false avant
        // que l'edit_file n'arrive, et cette condition échouait silencieusement :
        // plus aucun mécanisme ne fermait/relançait la session (le bug ECA
        // documenté ci-dessus empêche toute continuation naturelle), d'où un
        // blocage indéfini jusqu'au timeout global. Suppression du flag comme
        // garde : ce check est déjà strictement scopé à kind==='thesaurus-
        // assistant' + chemin thesaurus.org, et le protocole du skill garantit
        // que ce fichier n'est édité qu'après une réponse ask_user — aucun
        // risque de fermeture prématurée sur un edit_file non lié.
        if (kind === 'thesaurus-assistant'
            && toolInfo.name === 'edit_file'
            && toolInfo.path && toolInfo.path.includes('thesaurus.org')) {
          try {
            const thesContent = fs.readFileSync(toolInfo.path, 'utf8');
            const lines = thesContent.split('\n');
            // Trouver la section * Pending
            let inPending = false, hasDataRows = false;
            for (const line of lines) {
              if (/^\*\s+Pending/i.test(line.trim()))  { inPending = true; continue; }
              if (/^\*\s+/.test(line.trim()) && inPending) break; // section suivante
              if (!inPending) continue;
              const t = line.trim();
              if (!t.startsWith('|')) continue;
              if (/^\|[-+\s|]+\|?$/.test(t)) continue; // ligne séparatrice
              const cols = t.split('|').slice(1, -1).map(c => c.trim());
              if (cols[0] === 'Project term') continue; // header
              if (cols[0]) { hasDataRows = true; break; }
            }
            // Compter les termes restants dans Pending
            let remainingPending = 0;
            { let _ip = false;
              for (const _l of lines) {
                const _t = _l.trim();
                if (/^\*\s+Pending/i.test(_t))  { _ip = true; continue; }
                if (/^\*\s+/.test(_t) && _ip) break;
                if (!_ip || !_t.startsWith('|')) continue;
                if (/^\|[-+\s|]+\|?$/.test(_t)) continue;
                const _c = _t.split('|').slice(1,-1).map(s=>s.trim());
                if (_c[0] && _c[0] !== 'Project term') remainingPending++;
              }
            }

            // Fix (sur-déclenchement fermeture/relance) — ne traiter ce
            // edit_file comme "fin de cycle de décision" que si le nombre de
            // Pending a réellement diminué depuis le dernier edit_file vu
            // dans cette session. Sans cette garde, un ECA qui appellerait
            // eca__edit_file plusieurs fois pour la même décision (relecture,
            // édition en 2 étapes — hors protocole strict demandé mais non
            // garanti côté LLM) déclenchait une fermeture/relance de terminal
            // par appel, créant plusieurs terminaux pour un seul terme réellement
            // traité (constaté empiriquement : nombre de terminaux > nombre de
            // termes Pending initiaux). lastKnownPendingCount reste à null tant
            // qu'aucun edit_file n'a encore été vu — le tout premier passe
            // toujours (pas de base de comparaison).
            const isGenuineProgress = lastKnownPendingCount === null
              || remainingPending < lastKnownPendingCount;
            lastKnownPendingCount = remainingPending;

            if (!isGenuineProgress) {
              _dbg(`WEB-025d: edit_file sans diminution de Pending (${remainingPending}) — ignoré (pas de fermeture/relance)`);
            } else if (!hasDataRows) {
              // Pending vide → vérifier si au moins un alias a été confirmé
              // manuellement ("validated via chorus-web") — si oui, re-import
              // nécessaire ; si non (tout rejeté/hors-périmètre), pas de re-import.
              let hasConfirmedAliases = false;
              { let _ia = false;
                for (const _l of lines) {
                  const _t = _l.trim();
                  if (/^\*\s+Aliases/i.test(_t))   { _ia = true; continue; }
                  if (/^\*\s+/.test(_t) && _ia)    { _ia = false; continue; }
                  if (!_ia || !_t.startsWith('|')) continue;
                  if (/^\|[-+\s|]+\|?$/.test(_t))  continue;
                  if (/validated via chorus-web/i.test(_t)) { hasConfirmedAliases = true; break; }
                }
              }
              _dbg(`WEB-025d: Pending vide, hasConfirmedAliases=${hasConfirmedAliases} → close in 3s`);
              sseSend(res, 'thesaurus-status', { complete: true, remaining: 0, hasConfirmedAliases });
              postRespondPending = false;
              if (deferredDoneHandle) clearTimeout(deferredDoneHandle);
              deferredDoneHandle = setTimeout(() => {
                deferredDoneHandle = null;
                if (!finished && !waitingForUserInput) { clearTimeout(timeoutHandle); finish(); }
              }, 3000);
            } else {
              // Termes restants → signaler le restart au frontend, fermer dans 2s
              _dbg(`WEB-025d: ${remainingPending} Pending restant(s) → thesaurus-restart`);
              sseSend(res, 'thesaurus-restart', { remaining: remainingPending });
              postRespondPending = false;
              if (deferredDoneHandle) clearTimeout(deferredDoneHandle);
              deferredDoneHandle = setTimeout(() => {
                deferredDoneHandle = null;
                if (!finished) { clearTimeout(timeoutHandle); finish(); }
              }, 2000);
            }
          } catch (e) { _dbg('WEB-025d: erreur lecture thésaurus', e.message); }
        }
        // Bandeau "Skill actif" (Engine/TODO.org [#J] Axe 3) — détecte un
        // appel à l'outil natif ECA "skill" (chargement d'un skill Chorus)
        // et maintient un historique court côté session pour permettre au
        // frontend d'afficher "skill actif" même après défilement du log
        // principal, y compris en cas de reconnexion SSE à une session
        // déjà en cours (voir activeTerminals.get(sessionId).skillHistory).
        if (toolInfo.isSkillLoad && toolInfo.skillName) {
          const t = activeTerminals.get(sessionId);
          if (t) {
            t.currentSkill = toolInfo.skillName;
            t.skillHistory = t.skillHistory || [];
            if (t.skillHistory[t.skillHistory.length - 1] !== toolInfo.skillName) {
              t.skillHistory.push(toolInfo.skillName);
            }
          }
          sseSend(res, 'skill', {
            name: toolInfo.skillName,
            history: t ? t.skillHistory : [toolInfo.skillName],
          });
        }
        // Panneau de tâches (Engine/TODO.org [#J] Axe 4) — ECA fournit déjà
        // l'état consolidé complet de la todo-list à chaque appel eca__task
        // (classifyToolCall extrait ce bloc dans toolInfo.taskboard), donc
        // aucune reconstruction manuelle depuis les arguments plan/start/
        // complete n'est nécessaire côté serveur : on relaie tel quel et on
        // persiste dans activeTerminals pour une éventuelle reconnexion SSE.
        if (toolInfo.isTaskUpdate && toolInfo.taskboard) {
          const t2 = activeTerminals.get(sessionId);
          if (t2) t2.taskboard = toolInfo.taskboard;
          sseSend(res, 'taskboard', toolInfo.taskboard);
        }
        // Refresh live de l'onglet Tests (WEB-021) — détecte les écritures
        // sur les fichiers clés de résultats (.last-check-results.json,
        // .last-strengthen-report.json) et envoie un événement SSE 'refresh'
        // pour que le frontend puisse mettre à jour les badges de convergence
        // AVANT que le terminal n'ait reçu son DONE final.
        // Heuristique : eca__write_file envoie le chemin cible dans toolInfo
        // (extrait par classifyToolCall depuis les arguments de l'outil).
        // On teste sur le basename uniquement pour rester robuste aux chemins
        // absolus variables selon la machine/sandbox.
        if (toolInfo.name === 'eca__write_file' && toolInfo.path) {
          const base = require('path').basename(toolInfo.path);
          const REFRESH_TRIGGERS = new Set([
            '.last-check-results.json',
            '.last-strengthen-report.json',
            '.last-fix-history.json',
          ]);
          if (REFRESH_TRIGGERS.has(base)) {
            sseSend(res, 'refresh', { sbId });
          }
        }
      },
      onDone:    ()         => {
        // Guard WEB-025: if eca__ask_user is pending, the 'idle' event is transient
        // (ECA waiting for user input) — do NOT finish here.
        if (waitingForUserInput) return;
        // Guard WEB-025b: user just responded to an ask_user and ECA went idle.
        // This idle might be the inter-ask_user pause (ECA about to call another
        // ask_user) OR the genuine end. We can't tell yet — arm an 8s deferred
        // close: if another ask_user arrives, onAsk cancels it; otherwise the
        // timer fires and finish() is called. The timer starts HERE (from idle),
        // NOT from clearAskWait, so ECA can take as long as it needs to process
        // before going idle (edit_file, generate text, etc.) — the 8s window
        // only opens once ECA is actually idle.
        if (postRespondPending) {
          postRespondPending = false; // consume the flag — one idle, one timer
          if (deferredDoneHandle) clearTimeout(deferredDoneHandle);
          deferredDoneHandle = setTimeout(() => {
            deferredDoneHandle = null;
            if (!finished && !waitingForUserInput) { clearTimeout(timeoutHandle); finish(); }
          }, 8000);
          return;
        }
        // deferredDoneHandle still running (a previous idle armed it but onAsk
        // hasn't fired yet) — another idle arrived, don't double-close.
        if (deferredDoneHandle) return;
        clearTimeout(timeoutHandle);
        finish();
      },
      onError:   (err)      => { clearTimeout(timeoutHandle); finish(`ECA events: ${err.message}`); },
      // Visualisation des sous-agents parallèles (Engine/TODO.org [#J]
      // Axe 5, étape 2) — relaie le détail capté par eca-client.js
      // (grep/read_file/etc. exécutés À L'INTÉRIEUR d'un spawn_agent en
      // cours) via un événement SSE dédié, distinct du flux 'tool'
      // principal. Maintient aussi un état par session (subagents) pour
      // permettre au frontend de reconstituer l'historique complet d'un
      // sous-agent même après une reconnexion SSE, et pour une éventuelle
      // étape 3 (regroupement DOM) qui a besoin de connaître l'ensemble
      // des sous-agents déjà vus, pas seulement le dernier événement.
      onSubagentToolLog: (subagentChatId, toolInfo) => {
        if (finished) return;
        const t = activeTerminals.get(sessionId);
        if (t) {
          t.subagents = t.subagents || {};
          t.subagents[subagentChatId] = t.subagents[subagentChatId] || [];
          t.subagents[subagentChatId].push(toolInfo);
        }
        sseSend(res, 'subagent-tool', { subagentChatId, toolInfo });
      },
    });
    subReq = sReq;
    activeTerminals.set(sessionId, {
      finish, chatId, sbId, level, entityId, projId, reportFile,
      kind:         kind || null,
      startedAt:    Date.now(),
      lastMessage:  message.length > 160 ? message.slice(0, 160) + '…' : message,
      currentSkill: null,
      skillHistory: [],
      taskboard:    null,
      subagents:    {},
      // WEB-025: exposed by /respond to clear the ask_user guard and reset timeout
      clearAskWait: () => {
        // Grace period 3s avant de lever le guard waitingForUserInput.
        // Couvre le bref idle qu'ECA émet entre la réception de la réponse
        // et la reprise du traitement — sans cette grace, onDone → finish()
        // fermerait la session prématurément sur cet idle intermédiaire.
        // onChunk / onToolLog lèvent le guard immédiatement dès qu'ECA reprend.
        clearTimeout(gracePeriodHandle);
        gracePeriodHandle = setTimeout(() => {
          gracePeriodHandle = null;
          waitingForUserInput = false;
        }, 3000);
        // WEB-025b — Fix B : entrer en mode post-respond.
        // Le timer de close différé (8s) sera armé depuis onDone, quand ECA
        // passera effectivement à idle — PAS ici. Cela permet à ECA de prendre
        // le temps nécessaire (edit_file, génération de texte…) sans risque
        // de timeout prématuré.
        postRespondPending = true;
        // Restart du timeout — ECA a le temps plein pour finir après la réponse.
        clearTimeout(timeoutHandle);
        if (pendingTimeoutRestart) { clearTimeout(pendingTimeoutRestart); pendingTimeoutRestart = null; }
        timeoutHandle = setTimeout(
          () => finish(`timeout après ${Math.round(timeoutMs / 60_000)} min — skill encore en cours côté ECA`),
          timeoutMs
        );
      },
    });

    // ── Send the prompt ────────────────────────────────────────────────
    // Routage explicite skill → agent (Engine/TODO.org [#J] Axe 1) — via
    // eca.setChatAgent() (route REST POST /api/v1/chats/:id/agent,
    // confirmée empiriquement comme le seul mécanisme qui change
    // réellement l'agent d'un chat — le paramètre `agent` du body
    // /prompt lui-même n'a aucun effet observé, voir eca-client.js
    // § setChatAgent pour le détail de cette découverte). Best-effort :
    // un échec ne bloque jamais l'envoi du prompt.
    //
    // ⚠️ Cas nouveau chat (chatAlreadyExists === false) : POST /agent
    // échoue tant que le chat n'existe pas encore côté serveur ECA (créé
    // uniquement par le premier POST /prompt) — confirmé empiriquement
    // (404/erreur sur un chatId jamais vu). Stratégie retenue : envoyer
    // le prompt SANS l'attendre (fire-and-forget), patienter un court
    // délai (le temps que le serveur matérialise l'enregistrement du
    // chat — confirmé fiable dès 50ms en test réel), PUIS appeler
    // setChatAgent, et seulement ensuite attendre la vraie fin du prompt
    // via `promptPromise`. Cas chat existant : setChatAgent AVANT le
    // prompt fonctionne directement (pas de race condition à gérer).
    const expectedAgent = detectExpectedAgent(message);
    let promptPromise;

    if (chatAlreadyExists) {
      if (expectedAgent) await eca.setChatAgent(chatId, expectedAgent);
      promptPromise = eca.ecaRequest(
        `/api/v1/chats/${encodeURIComponent(chatId)}/prompt`, 'POST', { message: fullMessage }
      );
    } else {
      promptPromise = eca.ecaRequest(
        `/api/v1/chats/${encodeURIComponent(chatId)}/prompt`, 'POST', { message: fullMessage }
      );
      if (expectedAgent) {
        await new Promise((r) => setTimeout(r, 200)); // marge de sécurité vs. 50ms testé
        await eca.setChatAgent(chatId, expectedAgent);
      }
    }

    try {
      await promptPromise;
    } catch (err) {
      clearTimeout(timeoutHandle);
      finish(`Erreur POST prompt : ${err.message}`);
      return;
    }

    await done.catch(() => {});
    clearTimeout(timeoutHandle);
    finish();
  })().catch(err => sseError(res, err.message));
});

// ── POST /api/sandboxes/:sbId/terminal/respond ────────────────────────────
router.post('/sandboxes/:sbId/terminal/respond', async (req, res) => {
  const { sbId } = req.params;
  const { message, sessionId, toolId } = req.body;
  // "__passer__" : marqueur envoyé par le bouton ⏭️ Passer (widget Ambiguous tier).
  // ECA ignore un message vide → on envoie "passer" (non-vide) pour router
  // correctement la réponse vers le tool call ask_user actif.
  const isPasser  = message === '__passer__';
  const ecaAnswer = isPasser ? 'passer' : message;
  if (!isPasser && !message) return res.status(400).json({ ok: false, error: 'message manquant' });
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId manquant' });
  const chatId = `eca-term-${sbId}-${sessionId}`;
  const t = activeTerminals.get(sessionId);
  if (t?.clearAskWait) t.clearAskWait();
  // WEB-025c — Simplification du payload ask_user response.
  // isAskUserResponse:true + answer + toolId causaient un état ambigu côté
  // ECA : après le premier toolCalled (edit_file), ECA se bloquait
  // systématiquement sans continuer la génération.
  // Confirmé empiriquement (2026-11) : ECA interprète correctement une
  // réponse utilisateur via POST /prompt { message } seul (même mécanique
  // que sendLoginStep dans le flow de login) — ECA matche automatiquement
  // le message au tool call ask_user pending sans champs spéciaux.
  const payload = { message: ecaAnswer };
  try {
    await eca.ecaRequest(`/api/v1/chats/${encodeURIComponent(chatId)}/prompt`, 'POST', payload);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── POST /api/sandboxes/:sbId/terminal/stop ───────────────────────────────
router.post('/sandboxes/:sbId/terminal/stop', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.json({ ok: true, cancelled: false });
  const t = activeTerminals.get(sessionId);
  if (t) {
    t.finish('annulé par l\'utilisateur');
    res.json({ ok: true, cancelled: true });
  } else {
    res.json({ ok: true, cancelled: false });
  }
});

// ── DELETE /api/sandboxes/:sbId/terminal ──────────────────────────────────
router.delete('/sandboxes/:sbId/terminal', async (req, res) => {
  const { sbId } = req.params;
  const { sessionId } = req.body || {};
  if (!sessionId) return res.json({ ok: true, deleted: false });
  const chatId = `eca-term-${sbId}-${sessionId}`;
  const t = activeTerminals.get(sessionId);
  if (t) t.finish('session terminal fermée par l\'utilisateur');
  try {
    await eca.ecaRequest(`/api/v1/chats/${encodeURIComponent(chatId)}`, 'DELETE');
    res.json({ ok: true, deleted: true });
  } catch (err) {
    res.json({ ok: true, deleted: false, error: err.message });
  }
});

module.exports = router;
