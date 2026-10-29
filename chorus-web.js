// Version 17
// ─── STATE ────────────────────────────────────────────────────
let db = null;
let currentSandbox = null;
let currentEntityId = null;
let currentProject = null;
let pipelineRunning = false;

const SETTINGS = {
  // workspace / eca / models / pipeline : read-only, real values
  // loaded dynamically from /api/eca/info (cf. refreshModelsReadonly,
  // refreshServicesModalData) — no longer editable or persisted here.
  // Exception : eca.terminalTimeoutMinutes (configurable, voir panneau
  // Config § ECA Server) — contrôle la durée max d'attente d'une
  // session terminal (POST /terminal) avant abandon côté webapp. Le
  // skill ECA peut continuer de tourner après ce délai (ce réglage ne
  // pilote que l'écoute SSE webapp, pas le serveur eca-server) — voir
  // server/routes/terminal.js § timeoutHandle.
  eca: {
    terminalTimeoutMinutes: 60,
  },
  ui: {
    theme: 'dark', // 'dark' | 'light' | 'system'
    language: 'fr', // 'fr' | 'en'
    density: 'normal', // 'compact' | 'normal'
    notifications: true,
  },
};

// ─── DATA STORES (populated at runtime by initFromServer → GET /api/scan) ─────
const SANDBOXES  = [];   // filled by initFromServer()
const ENTITIES   = {};   // filled by initFromServer()
const PROJECTS   = {};   // filled by initFromServer()
const CORPUS_DATA = {};  // filled by initFromServer() / per-sandbox API calls

// ─── INIT ─────────────────────────────────────────────────────
function init() {
  renderGlobalDashboard();
  renderSidebar();
}

// ─── SERVER INTEGRATION MVP0 ──────────────────────────────────
// Replaces simulated data (SANDBOXES/ENTITIES/PROJECTS) with real
// data scanned from $CHORUS_HOME via GET /api/scan.
// If the server does not respond, the PoC continues in simulation mode.
const API = (location.origin && location.origin !== 'null') ? location.origin : 'http://localhost:3000';

async function initFromServer() {
  try {
    const r = await fetch(`${API}/api/scan`);
    if (!r.ok) throw new Error(await r.text());
    const { sandboxes } = await r.json();

    SANDBOXES.length = 0;
    Object.keys(PROJECTS).forEach(k => delete PROJECTS[k]);
    Object.keys(ENTITIES).forEach(k => delete ENTITIES[k]);

    // Convention backend : sb.entities[] (1er niveau de workspace/, pas de 'default')
    //   chaque entity a .projects[] — projet = workspace/<entity>/<projId>.json (flat)
    //   rapports  = workspace/<entity>/reports/ (flat, filtré par sous-chaîne projId)
    sandboxes.forEach((sb, i) => {
      const entry = buildSandboxEntry(sb, i);
      SANDBOXES.push(entry.sandbox);
      ENTITIES[sb.id] = entry.entities;
      PROJECTS[sb.id] = entry.projects;
    });

    renderGlobalDashboard();
    renderSidebar();
    // Home page = global dashboard (cf. POC chorus-v43): no longer
    // automatically pre-selects the first sandbox — the user chooses
    // manually via the dashboard or the sidebar.

  } catch (err) {
    console.warn('Serveur MVP0 non disponible — mode simulation', err.message);
  }
}

// Descending chronological sort (most recent first) of a report list —
// used by all panels displaying a list of run reports (pipeline panel,
// overview/"Reports" tab of the project page, history).
// Priority to `dateTime` (full timestamp, most precise — ISO or
// YYYY-MM-DDTHH:MM:SS); falls back to `date` (day only) if `dateTime`
// is absent; entries with no known date are pushed to the end of the list.
function sortReportsByDateDesc(reports) {
  return [...(reports || [])].sort((a, b) => {
    const da = a.dateTime || a.date || null;
    const db = b.dateTime || b.date || null;
    if (!da && !db) return 0;
    if (!da) return  1;
    if (!db) return -1;
    return new Date(db) - new Date(da);
  });
}

// Generates the 2 "mini-report" icons 📋 (summary) / 💡 (explain) linked to
// a run-report, clickable if the corresponding file exists (r.synthese_file
// / r.explain_file), greyed out otherwise with an explicit tooltip.
// Reference pattern — originally introduced in renderReportsList (pipeline panel),
// generalised here for reuse by all report lists in the webapp
// (project page, history, pipeline panel).
function reportMiniIcons(r, sbId, entityId, projId) {
  const synBtn = r.synthese_file
    ? `<button class="btn btn-ghost btn-sm" title="${r.synthese_file}"
         onclick="openMdView('${sbId}','${entityId}','${projId}','${r.synthese_file}')"
         style="font-size:13px;padding:2px 6px">📋</button>`
    : `<span style="font-size:13px;opacity:.25;padding:2px 6px;cursor:default"
         title="No --summary report for this run">📋</span>`;

  const expBtn = r.explain_file
    ? `<button class="btn btn-ghost btn-sm" title="${r.explain_file}"
         onclick="openMdView('${sbId}','${entityId}','${projId}','${r.explain_file}')"
         style="font-size:13px;padding:2px 6px">💡</button>`
    : `<span style="font-size:13px;opacity:.25;padding:2px 6px;cursor:default"
         title="No --explain report for this run">💡</span>`;

  // Returns raw buttons (no wrapper) — the caller is responsible for
  // grouping them with the other icons (View/Terminal) inside a common
  // flex container with minimal uniform spacing (gap:2px), for a visually
  // consistent alignment of all 4 icons.
  return synBtn + expBtn;
}

const SANDBOX_ICONS = ['🔐','📜','🏗️','♿','🏥','☁️','⚖️','🌍','📋'];

// Builds the { sandbox, entities, projects } entry expected by
// SANDBOXES/ENTITIES/PROJECTS from a raw sandbox object returned by
// the backend (same shape as each element of /api/scan or the single object
// from /api/sandboxes/:sbId). Factored out of initFromServer() to be
// reusable by refreshSandboxReports() (targeted refresh of a single sandbox
// after a run.pl / chorus-check / chorus-complete-report launched from the
// interactive ECA terminal — see its caller for context).
function buildSandboxEntry(sb, iconIndex) {
  const entityList = sb.entities || [];
  const allProjects = entityList.flatMap(e => e.projects || []);
  const imported = allProjects.filter(p => p.state === 'imported').length;
  const runs     = allProjects.filter(p => p.reportFile).length;
  const dates    = allProjects.map(p => p.reportData?.date).filter(Boolean).sort();

  // Conformité moyenne — moyenne des % de conformité sur tous les projets
  // ayant un rapport (évite de diluer avec les projets non encore exécutés).
  const runProjects = allProjects.filter(p => p.reportData && p.compliance != null);
  const complianceAvg = runProjects.length > 0
    ? Math.round(runProjects.reduce((s, p) => s + p.compliance, 0) / runProjects.length)
    : null;

  // Dernier run : entity + projet ayant la date de rapport la plus récente.
  let lastRunEntity = null, lastRunProject = null, lastRunDate = null;
  for (const e of entityList) {
    for (const p of (e.projects || [])) {
      const d = p.reportData?.date || null;
      if (d && (!lastRunDate || d > lastRunDate)) {
        lastRunDate = d; lastRunEntity = e.id; lastRunProject = p.id;
      }
    }
  }

  const sandbox = {
    id: sb.id,
    name: sb.name,
    icon: SANDBOX_ICONS[(iconIndex ?? 0) % SANDBOX_ICONS.length],
    color: '#64748B',
    desc: sb.desc || '',
    standard: sb.standard || sb.norm || '—',
    projects_total: allProjects.length,
    projects_imported: imported,
    runs,
    last_run: dates.length ? dates[dates.length - 1] : null,
    compliance_avg:   complianceAvg,
    last_run_entity:  lastRunEntity,
    last_run_project: lastRunProject,
    testing:         sb.testing         || { iso: null, edges: null, cross: null, scale: null },
    kbModeled:       !!sb.kbModeled,
    // strengthenReport — rapport chorus-strengthen (.last-strengthen-report.json)
    // lu par scanner.js § readLastStrengthenReport. Absent du rebuild initial →
    // renderKbConvergenceWorkflow affichait "Jamais analysé" après refreshSandboxReports.
    strengthenReport: sb.strengthenReport || null,
    // fixHistory — historique chorus-fix (.last-fix-history.json)
    // lu par scanner.js § readLastFixHistory. Persiste après convergence (total_gaps=0)
    // → permet d'afficher les corrections appliquées même quand strengthen montre 0 gap.
    fixHistory: sb.fixHistory || null,
  };

  const entities = entityList.map(e => ({
    id:    e.id,
    label: e.label || e.id,
    path:  `workspace/${e.id}`,
  }));

  const projects = entityList.flatMap(e => (e.projects || []).map(p => {
    // run.pl pipeline report (verdict + count) — at most one, the
    // most recent known for this project.
    // p.reportFile is already relative to workspace/<entity>/ — either
    // "reports/xxx.json" (current convention), "../../reports/xxx.json"
    // (legacy sandbox root), or a plain markdown filename
    // ("compliance-report-xxx.md", implicitly under reports/).
    // All run-reports (most recent first for display)
    const runReportEntry = (p.runEntries && p.runEntries.length
      ? [...p.runEntries].reverse()   // most recent first
      : p.reportFile ? [{ file: p.reportFile, dir: null, data: p.reportData }] : []
    ).map(entry => {
      const fname = entry.file;
      const rdata = entry.data || p.reportData || {};
      const relPath = fname
        ? (/^reports\//.test(fname) ? fname : `reports/${fname}`)
        : null;
      return {
        icon:  '📋', kind: 'run', label: fname || p.reportFile,
        desc:  `${rdata.pipeline_solved ? 'SOLVED' : (p.verdict || '?')} · ${rdata.n_conforme ?? p.reportData?.conformes ?? 0}/${rdata.n_total ?? p.frames ?? 0} CONFORMES`,
        path:  relPath ? `sandboxes/${sb.id}/workspace/${e.id}/${relPath}` : '',
        date:  (rdata.generated_at || p.reportData?.date || '').slice(0,10) || new Date().toISOString().slice(0,10),
        dateTime: rdata.generated_at || p.reportData?.date || null,
        run:   'run.pl',
        explain_file:  entry.explain_file  ?? null,
        synthese_file: entry.synthese_file ?? null,
      };
    });

    // chorus-check reports (synthese-/explain-*.md) — only those
    // NOT already linked by timestamp to an existing run-report.
    // Linked files are already accessible via the 📋/💡 buttons on
    // their run row — duplicating them here would cause confusion.
    const linkedByRun = new Set(
      runReportEntry.flatMap(r => [r.explain_file, r.synthese_file]).filter(Boolean)
    );
    const checkReportEntries = (p.checkReports || [])
      .filter(filename => !linkedByRun.has(filename))
      .map(filename => {
        // Production date extracted from the filename — two formats
        // coexist depending on origin: YYYYMMDD-HHMMSS (ECA skill /
        // terminal, cf. chorus-complete-report.md et al.) or YYYYMMDD
        // only (legacy server.js § writeCheckReport, ROUTE 4
        // /check?action=). These reports have no structured date field
        // of their own (unlike run-reports which carry generated_at
        // in their JSON) — without this extraction they could never
        // be sorted or display a date in the UI (see chorus-web.html
        // § report lists).
        const tsMatch = filename.match(/-(\d{4})(\d{2})(\d{2})(?:-(\d{2})(\d{2})(\d{2}))?\.md$/);
        const date = tsMatch ? `${tsMatch[1]}-${tsMatch[2]}-${tsMatch[3]}` : null;
        // Full timestamp (minute precision if available, otherwise 00:00:00) —
        // used for chronological sorting of report lists; `date` (day only)
        // remains the displayed format, unchanged for compat with existing
        // code that already depends on it (pvReportRow, day-grouping in
        // openHistoryModal, etc.).
        const dateTime = tsMatch
          ? `${tsMatch[1]}-${tsMatch[2]}-${tsMatch[3]}T${tsMatch[4]||'00'}:${tsMatch[5]||'00'}:${tsMatch[6]||'00'}`
          : null;
        return {
          icon: filename.startsWith('explain-') ? '💡' : '📋',
          kind: filename.startsWith('explain-') ? 'explain' : 'summary',
          label: filename,
          desc: filename.startsWith('explain-')
            ? 'Explications règle par règle (chorus-check --explain)'
            : 'Synthèse 1 page (chorus-check --summary)',
          path: `sandboxes/${sb.id}/workspace/${e.id}/reports/${filename}`,
          date,
          dateTime,
          run: filename.startsWith('explain-') ? 'chorus-check --explain' : 'chorus-check --summary',
        };
      });

    // Journal de décisions terminologiques (thesaurus-log-<slug>.md)
    const thesLogEntry = p.thesaurusLog ? [{
      icon:  '📒',
      kind:  'thesaurus-log',
      label: p.thesaurusLog,
      desc:  'Journal de décisions terminologiques (résolutions depuis l\'onglet Thésaurus)',
      path:  `sandboxes/${sb.id}/workspace/${e.id}/reports/${p.thesaurusLog}`,
      date:  null,
      dateTime: null,
      run:   null,
    }] : [];

    return {
      id: p.id,
      name: p.name,
      type: 'pdf',
      entity: e.id,
      sourceFile:     p.sourceFile     || null,
      sourceBasename: p.sourceBasename || null,
      frames: p.frames || 0,
      evidence: 0,
      state: p.state,
      compliance: p.compliance,
      nonConformes: p.reportData?.nonConformes ?? null,
      aConfirmer:   p.reportData?.aConfirmer   ?? null,
      lastRun:    p.reportData?.date || null,
      importDate: (p.imports && p.imports.length)
        ? [...p.imports].sort((a,b) => (b.date||'') > (a.date||'') ? 1 : -1)[0].date || null
        : null,
      verdict: p.verdict,
      imports: p.imports || [],
      reports: [...runReportEntry, ...checkReportEntries, ...thesLogEntry],
      corpus: [],
      audit:  p.audit  || null,
    };
  }));

  return { sandbox, entities, projects };
}

// Targeted refresh of a single sandbox — called after an interactive ECA
// terminal (level 'project'/'report') may have produced new reports
// (run.pl relaunched, chorus-check --summary/--explain, chorus-complete-report)
// WITHOUT going through the direct SSE stream of runPipeline()/runChorusCheckAction()
// (which already update PROJECTS[...] locally). Without this call,
// window._lastReports / PROJECTS[sbId] would remain frozen on the state before
// the ECA command until the next F5 — same issue as the one fixed in
// finishPipeline()/runChorusCheckAction(), but on this distinct path.
// Best-effort: if the scan fails (network, sandbox not found), silently
// ignore rather than breaking the ongoing terminal session.
async function refreshSandboxReports(sbId) {
  if (!sbId) return;
  try {
    const r = await fetch(`${API}/api/sandboxes/${sbId}`);
    if (!r.ok) return;
    const { sandbox: sb } = await r.json();
    if (!sb) return;

    const iconIndex = Math.max(0, SANDBOXES.findIndex(s => s.id === sbId));
    const entry = buildSandboxEntry(sb, iconIndex);

    // Replace the existing SANDBOXES entry (preserves display order)
    const idx = SANDBOXES.findIndex(s => s.id === sbId);
    if (idx >= 0) SANDBOXES[idx] = entry.sandbox; else SANDBOXES.push(entry.sandbox);
    ENTITIES[sbId] = entry.entities;
    PROJECTS[sbId] = entry.projects;

    // Re-sync currentProject/_lastReports if the displayed page concerns
    // exactly this sandbox/project, so that already-rendered buttons
    // (e.g. 📊 View) reflect the new files without an F5.
    if (currentSandbox?.id === sbId) {
      currentSandbox = entry.sandbox;
      if (currentProject) {
        const freshProj = entry.projects.find(p => p.id === currentProject.id);
        if (freshProj) {
          currentProject = freshProj;
          window._lastReports = freshProj.reports || [];
        }
      }
    }

    renderSidebar();
    renderGlobalDashboard();
    if (document.getElementById('page-project')?.classList.contains('active') && currentProject) {
      const ent = entry.entities.find(e => e.id === currentProject.entity);
      renderProjectPage(currentProject, ent ? ent.label : (currentProject.entity || ''));
    } else {
      renderProjectsTab();
    }
    // Onglet "Tests" — rafraîchit les badges lastRun/convergence si l'onglet
    // est actuellement affiché sur CE sandbox (ex. après un test lancé via
    // runTestingStrategy, terminal de niveau 'sandbox' — voir levelTerminalExec).
    if (currentSandbox?.id === sbId && document.getElementById('tab-tests')?.classList.contains('active')) {
      renderTestingTab();
    }
    // Pipeline panel, if open on this project — refreshes ONLY the most
    // recent report (the one produced by the current/just-finished run),
    // not the full run-report history of the project. The pipeline execution
    // panel should show "the generated report", not a list — the full history
    // remains available via the Reports tab of the project page.
    if (!document.getElementById('pipeline-modal-overlay')?.hidden && currentProject) {
      const runReports = sortReportsByDateDesc(
        (currentProject.reports || []).filter(r => r.kind === 'run')
      );
      if (runReports.length) renderReportsList([runReports[0]]);
    }
  } catch (e) {
    console.warn('refreshSandboxReports: scan impossible —', e.message);
  }
}

// ─── PROJECT PAGE ─────────────────────────────────────────────
const TYPE_ICONS = { pdf: '📄', docx: '📝', zip: '🗜️', url: '🌐' };

function selectProject(projId) {
  if (!currentSandbox) return;
  const proj = (PROJECTS[currentSandbox.id] || []).find(p => p.id === projId);
  if (!proj) return;
  currentProject = proj;

  // Breadcrumb
  const ents = (typeof ENTITIES !== 'undefined' ? ENTITIES[currentSandbox.id] : null) || [];
  const ent  = ents.find(e => e.id === proj.entity);
  const entLabel = ent ? ent.label : (proj.entity || '');

  document.getElementById('bc-sandbox').textContent = currentSandbox.name;
  if (entLabel) {
    document.getElementById('bc-entity').textContent = entLabel;
    document.getElementById('bc-entity').hidden = false;
    document.getElementById('bc-sep1').hidden   = false;
  } else {
    document.getElementById('bc-entity').hidden = true;
    document.getElementById('bc-sep1').hidden   = true;
  }
  document.getElementById('bc-project').textContent = proj.name;
  document.getElementById('bc-project').hidden = false;
  document.getElementById('bc-sep2').hidden    = false;

  // Switch page
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-project').classList.add('active');

  // Sidebar active
  document.querySelectorAll('.sandbox-item').forEach(el => el.classList.remove('active'));
  document.getElementById('sb-item-' + currentSandbox.id)?.classList.add('active');

  renderProjectPage(proj, entLabel);
}

function pvSwitchTab(name) {
  document.querySelectorAll('.pv-tab-btn').forEach(b => {
    const prefixMap = { apercu: 'ap', imports: 'im', rapports: 'ra', thesaurus: 'th' };
    b.classList.toggle('active', b.textContent.toLowerCase().startsWith(prefixMap[name] || name));
  });
  document.querySelectorAll('.pv-tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('pv-tab-' + name)?.classList.add('active');
  // Lazy loading — the Thesaurus panel fetches /api/sandboxes/:sbId/corpus
  // (data.thesaurus, same endpoint as the sandbox-level Corpus modal) only
  // on the first tab click, not at project open.
  if (name === 'thesaurus') renderPvThesaurusTab();
}

// Retourne uniquement les boutons d'action pour un rapport (👁️ + 🖥️).
// Used by pvReportRow and directly by the "Last run" panel.
function pvReportButtons(r, proj, sbId) {
  const isMd      = r.label && r.label.endsWith('.md');
  const isJson    = r.kind === 'run' && r.label && r.label.endsWith('.json');
  const isSummary = r.kind === 'summary';
  const isExplain = r.kind === 'explain';
  const safeProj  = (proj.name || '').replace(/'/g, "\\'");

  let viewBtn = '';
  if (isMd || isSummary || isExplain) {
    const lbl = isSummary ? '👁️ Summary' : isExplain ? '👁️ Explain' : '👁️';
    viewBtn = `<button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:10px;flex-shrink:0"
      title="Voir ${r.label}"
      onclick="openMdView('${sbId}','${proj.entity}','${proj.id}','${r.label}')">${lbl}</button>`;
  } else if (isJson) {
    viewBtn = `<button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:10px;flex-shrink:0"
      title="Voir ${r.label}"
      onclick="openReportView({label:'${r.label}',kind:'run',run:'run.pl'},{sbId:'${sbId}',sbName:'${(currentSandbox&&currentSandbox.name)||sbId}',entityId:'${proj.entity}',projId:'${proj.id}',projName:'${safeProj}'})">👁️</button>`;
  }

  const termBtn = `<button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:10px;flex-shrink:0"
    title="Terminal ECA — ${r.label}"
    onclick="openLevelTerminal('report',{sbId:'${sbId}',entityId:'${proj.entity}',projId:'${proj.id}',projName:'${safeProj}',reportFile:'${r.label}',explainFile:${r.explain_file ? `'${r.explain_file}'` : 'null'},syntheseFile:${r.synthese_file ? `'${r.synthese_file}'` : 'null'}})">🖥️</button>`;

  // 📋 summary / 💡 explain icons — only relevant on a run-report row
  // (the summary/explain file itself does not need to reference itself).
  const miniIcons = isJson ? reportMiniIcons(r, sbId, proj.entity, proj.id) : '';

  return `<div style="display:flex;align-items:center;gap:2px">${miniIcons}${viewBtn}${termBtn}</div>`;
}

// Generates the HTML for a full report row with the same buttons as the history modal.
function pvReportRow(r, proj, sbId) {
  return `
    <div class="pv-report-row">
      <span class="pv-report-icon">${r.icon || '📋'}</span>
      <div class="pv-report-info">
        <div class="pv-report-name">${r.label}</div>
        <div class="pv-report-desc">${r.desc || ''}</div>
      </div>
      <span class="pv-report-date">${r.date || ''}</span>
      <div style="display:flex;gap:2px;flex-shrink:0">${pvReportButtons(r, proj, sbId)}</div>
    </div>`;
}

function renderProjectPage(proj, entLabel) {
  const sb = currentSandbox;
  const imports = proj.imports || [];
  const compColor = proj.compliance >= 80 ? 'var(--success)' : proj.compliance >= 50 ? 'var(--warn)' : 'var(--error)';

  // ── Header ───────────────────────────────────────────────────
  document.getElementById('pv-type-icon').textContent  = TYPE_ICONS[proj.type] || '📁';
  document.getElementById('pv-title').textContent      = proj.name;
  document.getElementById('pv-meta-sandbox').textContent = sb.icon + ' ' + sb.name;
  document.getElementById('pv-meta-entity').textContent  = entLabel || '—';
  const backBtn = document.getElementById('pv-btn-back-entity');
  if (backBtn) backBtn.textContent = '← ' + (entLabel || 'Entity');
  document.getElementById('pv-meta-id').textContent      = proj.id;

  // State badge removed from the header (redundant — the "Imported"/"Not imported"
  // info is already visible via the Pipeline/Re-import buttons, themselves hidden
  // based on proj.state, cf. below).
  const btnPipeline = document.getElementById('pv-btn-pipeline');
  const btnReimport = document.getElementById('pv-btn-reimport');
  btnPipeline.style.display = proj.state === 'imported'  ? '' : 'none';
  btnReimport.style.display = proj.state !== 'available' ? '' : 'none';

  // ── KPI cards ─────────────────────────────────────────────────
  document.getElementById('pv-kpi-frames').textContent    = proj.frames ?? '—';
  document.getElementById('pv-kpi-frames-sub').textContent = proj.frames ? 'corpus frames' : '';
  // KPI "Non conformes" — lu depuis reportData.nonConformes (direct, pas de back-calcul)
  // Le back-calcul (frames - round(compliance% × frames)) était incorrect : il incluait
  // les éléments _a_confirmer dans les non-conformes (ex: 47+4+5=56 frames, 84% → 9 au
  // lieu de 4 car round(84%×56)=47, 56-47=9 ≠ n_non_conforme=4).
  if (proj.compliance != null && proj.frames) {
    const nonconf  = proj.nonConformes ?? (proj.frames - Math.round(proj.compliance / 100 * proj.frames));
    const ncColor  = nonconf === 0 ? 'var(--success)' : nonconf <= 3 ? 'var(--warn)' : 'var(--error)';
    document.getElementById('pv-kpi-nonconf').textContent       = nonconf;
    document.getElementById('pv-kpi-nonconf').style.color       = ncColor;
    document.getElementById('pv-kpi-nonconf-sub').textContent   = nonconf === 0 ? 'tout conforme ✓' : `sur ${proj.frames} exigences`;
  } else {
    document.getElementById('pv-kpi-nonconf').textContent       = '—';
    document.getElementById('pv-kpi-nonconf').style.color       = 'var(--text-muted)';
    document.getElementById('pv-kpi-nonconf-sub').textContent   = 'aucun run';
  }

  // KPI "À confirmer" — éléments _a_confirmer du dernier run
  const runReports = (proj.reports || []).filter(r => r.kind === 'run');
  const nAConf = proj.aConfirmer ?? null;
  const aConfEl    = document.getElementById('pv-kpi-aconfirmer');
  const aConfSub   = document.getElementById('pv-kpi-aconfirmer-sub');
  if (nAConf != null) {
    aConfEl.textContent     = nAConf || '0';
    aConfEl.style.color     = nAConf > 0 ? 'var(--warn)' : 'var(--success)';
    aConfSub.textContent    = nAConf === 0 ? 'tout résolu ✓' : `élément${nAConf > 1 ? 's' : ''} incertain${nAConf > 1 ? 's' : ''}`;
  } else {
    aConfEl.textContent     = '—';
    aConfEl.style.color     = 'var(--text-muted)';
    aConfSub.textContent    = 'aucun run';
  }

  // KPI "Dernier run" — date + verdict SOLVED/FAILED
  const kpiLastRun = runReports[runReports.length - 1];
  if (kpiLastRun) {
    const isSolved   = (kpiLastRun.desc || '').toUpperCase().includes('SOLVED');
    const verdictLbl = isSolved ? 'SOLVED' : 'FAILED';
    const verdictClr = isSolved ? 'var(--success)' : 'var(--error)';
    document.getElementById('pv-kpi-lastrun').textContent     = kpiLastRun.date || proj.lastRun || '—';
    document.getElementById('pv-kpi-lastrun').style.color     = 'var(--text-secondary)';
    document.getElementById('pv-kpi-lastrun-sub').textContent = verdictLbl;
    document.getElementById('pv-kpi-lastrun-sub').style.color = verdictClr;
  } else if (proj.lastRun) {
    document.getElementById('pv-kpi-lastrun').textContent     = proj.lastRun;
    document.getElementById('pv-kpi-lastrun').style.color     = 'var(--text-secondary)';
    document.getElementById('pv-kpi-lastrun-sub').textContent = '';
  } else {
    document.getElementById('pv-kpi-lastrun').textContent     = '—';
    document.getElementById('pv-kpi-lastrun').style.color     = 'var(--text-muted)';
    document.getElementById('pv-kpi-lastrun-sub').textContent = 'jamais lancé';
  }

  // ── Reset tabs ────────────────────────────────────────────────
  pvSwitchTab('apercu');

  // ── Tab Overview ─────────────────────────────────────────────
  let apercuHtml = '';

  // Compliance bar
  if (proj.compliance != null) {
    const conform = Math.round(proj.compliance / 100 * (proj.frames || 0));
    apercuHtml += `
      <div class="pv-comp-bar-wrap">
        <div class="pv-comp-bar-label">
          <span class="pv-comp-pct" style="color:${compColor}">${proj.compliance}%</span>
          <span class="pv-comp-detail">${conform} / ${proj.frames || '?'} frames conformes · last run ${proj.lastRun || '—'}</span>
        </div>
        <div class="pv-comp-bar">
          <div class="bar" style="width:${proj.compliance}%;background:${compColor}"></div>
        </div>
      </div>`;
  } else {
    apercuHtml += `<div class="pv-comp-bar-wrap"><div class="pv-empty">Aucune analyse de conformité disponible — lancez le pipeline.</div></div>`;
  }

  // Overview grid: last import + quick reports — sorted by date desc
  // (most recent first), consistent with other report lists in the app.
  const reports = sortReportsByDateDesc(proj.reports || []);
  const quickReports = reports.slice(0, 3);

  apercuHtml += `<div class="pv-overview-grid">`;

  // Last run card — reports is already sorted desc, so the first 'run'
  // found is indeed the most recent (no need for .reverse()).
  const lastRunReport = reports.find(r => r.kind === 'run');
  // Verdict : extrait du desc (ex: "SOLVED · 27/31 CONFORMES" ou "FAILED · …")
  const verdictRaw  = lastRunReport?.desc || '';
  const isSolved    = verdictRaw.toUpperCase().includes('SOLVED');
  const isFailed    = verdictRaw.toUpperCase().includes('FAILED');
  const verdictColor = isSolved ? 'var(--success)' : isFailed ? 'var(--error)' : 'var(--text-muted)';
  const verdictWord  = isSolved ? 'SOLVED' : isFailed ? 'FAILED' : (proj.lastRun ? '—' : null);

  apercuHtml += `<div class="pv-panel"><div class="pv-panel-title">Dernier run</div>`;
  if (proj.lastRun || lastRunReport) {
    const conform = (proj.compliance != null && proj.frames)
      ? Math.round(proj.compliance / 100 * proj.frames)
      : null;
    apercuHtml += `<div class="pv-last-import">
      <div class="pv-li-row">
        <span class="pv-li-key">Date</span>
        <span class="pv-li-val">${proj.lastRun || lastRunReport?.date || '—'}</span>
      </div>
      ${verdictWord ? `<div class="pv-li-row">
        <span class="pv-li-key">Verdict</span>
        <span class="pv-li-val" style="color:${verdictColor};font-weight:700">${verdictWord}</span>
      </div>` : ''}
      ${conform != null ? `<div class="pv-li-row">
        <span class="pv-li-key">Conformes</span>
        <span class="pv-li-val">${conform} / ${proj.frames} frames</span>
      </div>` : ''}
      ${proj.compliance != null ? `<div class="pv-li-row">
        <span class="pv-li-key">Score</span>
        <span class="pv-li-val" style="color:${compColor};font-weight:700">${proj.compliance}%</span>
      </div>` : ''}
      ${lastRunReport ? `<div class="pv-li-row" style="margin-top:4px;gap:6px;flex-wrap:wrap">
        <span class="pv-li-key">Rapport</span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-secondary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${lastRunReport.label}</span>
        <div style="display:flex;gap:2px;flex-shrink:0">${pvReportButtons(lastRunReport, proj, sb.id)}</div>
      </div>` : ''}
    </div>`;
  } else {
    apercuHtml += `<div class="pv-empty">Aucun run — lancez <strong>▶ Pipeline</strong> pour produire un rapport.</div>`;
  }
  apercuHtml += `</div>`;

  // Quick reports card
  apercuHtml += `<div class="pv-panel"><div class="pv-panel-title">Rapports récents</div>`;
  if (quickReports.length) {
    apercuHtml += quickReports.map(r => pvReportRow(r, proj, sb.id)).join('');
    if (reports.length > 3) apercuHtml += `<div style="font-size:11px;color:var(--text-muted);margin-top:6px;text-align:right;cursor:pointer" onclick="pvSwitchTab('rapports')">+${reports.length - 3} autres → Rapports</div>`;
  } else {
    apercuHtml += `<div class="pv-empty">Aucun rapport disponible.</div>`;
  }
  apercuHtml += `</div>`;

  // ── Audit import panel ────────────────────────────────────────
  const aud = proj.audit || null;
  apercuHtml += `<div class="pv-panel"><div class="pv-panel-title">🔬 Audit import</div>`;
  if (!aud) {
    apercuHtml += `
      <div class="pv-empty" style="margin-bottom:8px">Audit non effectué — <code>chorus-audit-import</code> jamais lancé sur ce projet.</div>
      <button class="btn btn-ghost btn-sm" onclick="startAudit('${proj.id}')" style="font-size:11px">🔬 Auditer</button>`;
  } else {
    const actionable = (aud.gapsComblables||0) + (aud.gapsPartiels||0) + (aud.gapsMapping||0) + (aud.framesManquantes||0);
    const statusClr = actionable === 0 ? 'var(--success)' : 'var(--warn)';
    const patchNote = aud.patchApplied
      ? `${aud.patchesApplied || 0} slot(s) auto-rempli(s) depuis la source`
      : '';
    const statusTxt = actionable === 0
      ? (aud.patchApplied ? `✅ Audité · ${patchNote}` : '✅ Aucun gap actionnable')
      : `⚠ ${actionable} gap(s) restant(s)`;
    const patchTooltip = aud.patchApplied
      ? `title="Slots auto-remplis par chorus-audit-import --patch depuis le document source. Consulter le rapport pour le détail (element_id · slot · valeur injectée)."`
      : '';
    const rows = [
      aud.gapsComblables   > 0 ? `<div class="pv-li-row"><span class="pv-li-key">✅ Comblables</span><span class="pv-li-val" style="color:var(--success)">${aud.gapsComblables} slot(s) à auto-remplir (--patch disponible)</span></div>` : '',
      aud.patchesApplied   > 0 ? `<div class="pv-li-row" ${patchTooltip}><span class="pv-li-key">✅ Patchés</span><span class="pv-li-val" style="color:var(--success)">${aud.patchesApplied} slot(s) auto-rempli(s) depuis la source · <em style="font-weight:normal;opacity:.75">détail dans le rapport</em></span></div>` : '',
      aud.gapsPartiels     > 0 ? `<div class="pv-li-row"><span class="pv-li-key">⚠️ Partiels</span><span class="pv-li-val" style="color:var(--warn)">${aud.gapsPartiels} — source incomplète</span></div>` : '',
      aud.gapsMapping      > 0 ? `<div class="pv-li-row"><span class="pv-li-key">🔄 Mappings</span><span class="pv-li-val" style="color:var(--warn)">${aud.gapsMapping} — décision ingénieur</span></div>` : '',
      aud.framesManquantes > 0 ? `<div class="pv-li-row"><span class="pv-li-key">🚫 Frames</span><span class="pv-li-val" style="color:var(--error)">${aud.framesManquantes} type(s) manquant(s)</span></div>` : '',
      aud.gapsAbsents      > 0 ? `<div class="pv-li-row"><span class="pv-li-key">❌ Absents</span><span class="pv-li-val" style="color:var(--text-muted)">${aud.gapsAbsents} — hors périmètre</span></div>` : '',
    ].filter(Boolean).join('');
    const auditDate = aud.date ? `<span style="font-size:10px;color:var(--text-muted);margin-left:8px">${aud.date}</span>` : '';
    const reportLink = ''; // remplacé par le bouton "📄 Rapport détaillé" dans auditNextAction
    const auditBtnInner = auditNextAction(aud, proj.id, false, '', proj.entity || '');
    apercuHtml += `
      <div style="font-size:12px;font-weight:600;color:${statusClr};margin-bottom:6px">${statusTxt}${auditDate}</div>
      <div class="pv-last-import">${rows}</div>
      ${reportLink}
      <div style="margin-top:8px">${auditBtnInner}</div>`;
  }
  apercuHtml += `</div>`;

  apercuHtml += `</div>`; // close pv-overview-grid

  document.getElementById('pv-tab-apercu').innerHTML = apercuHtml;

  // ── Tab Imports ───────────────────────────────────────────────
  let importsHtml = '';
  if (imports.length) {
    importsHtml += `<table class="pv-import-table">
      <thead><tr>
        <th>Date</th><th>Version</th><th>Frames</th><th>Modèle</th><th>Note</th>
      </tr></thead><tbody>`;
    [...imports].reverse().forEach(imp => {
      importsHtml += `<tr>
        <td style="font-family:'JetBrains Mono',monospace">${imp.date}</td>
        <td><span class="pv-version-badge">${imp.version}</span></td>
        <td style="color:var(--accent);font-family:'JetBrains Mono',monospace">${imp.frames}</td>
        <td style="color:var(--text-secondary)">${imp.model || '—'}</td>
        <td style="color:var(--text-muted);font-size:11px">${imp.note || '—'}</td>
      </tr>`;
    });
    importsHtml += `</tbody></table>`;
  } else {
    importsHtml = `<div class="pv-empty">Aucun historique d'import.</div>`;
  }
  document.getElementById('pv-tab-imports').innerHTML = importsHtml;

  // ── Tab Rapports ──────────────────────────────────────────────
  let rapportsHtml = '';
  if (reports.length) {
    rapportsHtml = reports.map(r => pvReportRow(r, proj, sb.id)).join('');
  } else {
    rapportsHtml = `<div class="pv-empty">Aucun rapport généré pour ce projet. Lancez le pipeline pour en créer.</div>`;
  }
  document.getElementById('pv-tab-rapports').innerHTML = rapportsHtml;
}

// ── Tab Thesaurus (vue Projet) ────────────────────────────────
//
// Displays, for the selected project only, the thesaurus alignments that
// are resolved (✅) and unresolved (⚠️ Pending) for that project, via
// correlation by source filename (proj.sourceBasename, derived server-side
// from project.json._import._source_fichier — cf. scanFlatProject())
// against the "Source import" column of each row in the sharded thesaurus
// (agent/thesaurus/*.org, already exposed by /api/sandboxes/:sbId/corpus →
// data.thesaurus). Augments the ⚠️ Pending thesaurus entries with the
// `_a_confirmer` elements of the run-report itself (uncertainty already
// detected pipeline-side, not only import-side).
//
// Lazy loading (triggered by pvSwitchTab on the first click), cached by
// project. No navigation to an Agents panel — all useful content is
// displayed directly here, read-only; only a fallback link at the bottom
// opens the full sandbox thesaurus (unfiltered) for cases where per-project
// filtering is not sufficient.
let _pvThesaurusCache = {}; // "sbId/entity/projId" → { matched, hasFilter }

function _basenameNoExt(p) {
  if (!p) return null;
  const base = p.split('/').pop();
  return base.replace(/\.[^.]+$/, '');
}

// Distinguishes alignments auto-resolved at import time (chorus-import-project,
// confidence written verbatim as "✅ confirmed") from alignments resolved
// manually afterwards via the webapp's inline Pending confirmation
// (resolveThesaurusPending, server/chorus/thesaurus.js — confidence written as
// "✅ confirmed (validated via chorus-web <date>)"). Both share the same ✅
// prefix in the org file; only this suffix differentiates them — see
// chorus-import-project.md § "Write format per section" vs
// thesaurus.js § resolveThesaurusPending.
function _pvThesOrigin(confidence) {
  const m = (confidence || '').match(/validated via chorus-web ([\d-]+)/);
  if (m) return { kind: 'manual', date: m[1] };
  return { kind: 'import', date: null };
}

// Renders the "Origine" column badge — 📥 Import (linked to the source
// import report) or ✍️ Résolution manuelle (with the validation date).
function _pvThesOriginBadge(confidence, sourceImport) {
  const origin = _pvThesOrigin(confidence);
  if (origin.kind === 'manual') {
    return `<span style="color:var(--accent)" title="Confirmé manuellement le ${origin.date}">✍️ Manuel (${origin.date})</span>`;
  }
  return `<span style="color:var(--text-muted)" title="Résolu automatiquement lors de l'import">📥 ${sourceImport || 'Import'}</span>`;
}

async function renderPvThesaurusTab() {
  const proj = currentProject, sb = currentSandbox;
  if (!proj || !sb) return;
  const panel = document.getElementById('pv-tab-thesaurus');
  if (!panel) return;

  const cacheKey = `${sb.id}/${proj.entity}/${proj.id}`;
  let cached = _pvThesaurusCache[cacheKey];

  if (!cached) {
    panel.innerHTML = '<div class="pv-empty">Chargement…</div>';
    let thesaurus = [];
    try {
      const r = await fetch(`${API}/api/sandboxes/${sb.id}/corpus`);
      if (r.ok) thesaurus = (await r.json()).corpus?.thesaurus || [];
    } catch { /* backend indisponible — tableau vide, message ci-dessous */ }

    const target = proj.sourceBasename; // ex: "project-simul-01" — null si _import absent/illisible
    const hasFilter = !!target;

    // Merges all shards (global.org + optional client shards) — per-project
    // filtering does not need to distinguish Scopes; only the
    // Source import column matters here.
    const allTypeElement = thesaurus.flatMap(s => s.aliasesTypeElement.map(a => ({ ...a, shard: s.shard })));
    const allSlotValues  = thesaurus.flatMap(s => s.aliasesSlotValues.map(a => ({ ...a, shard: s.shard })));
    const allPending     = thesaurus.flatMap(s => s.pending.map(a => ({ ...a, shard: s.shard })));

    // Matching priority: server-resolved sourceBasename (from the import
    // report's own #+SOURCE: header — reliable, handles the common case
    // where "Source import" is just "import-report-NNN") > legacy inline
    // basename fallback (sourceImport already contains a filename, e.g.
    // "import-report-002 (workspace/test/reports/)") — see
    // chorus/thesaurus.js § _resolveSourceImportBasename for why this
    // two-tier resolution is needed.
    const matches = (row) => hasFilter &&
      (row.sourceBasename ? row.sourceBasename === target : _basenameNoExt(row.sourceImport) === target);

    cached = {
      hasFilter,
      hasAnyThesaurus: thesaurus.length > 0,
      resolvedTypeElement: hasFilter ? allTypeElement.filter(matches) : allTypeElement,
      resolvedSlotValues:  hasFilter ? allSlotValues.filter(matches)  : allSlotValues,
      pending:             hasFilter ? allPending.filter(matches)     : allPending,
    };
    _pvThesaurusCache[cacheKey] = cached;
  }

  const { hasFilter, hasAnyThesaurus, resolvedTypeElement, resolvedSlotValues, pending } = cached;

  if (!hasAnyThesaurus) {
    panel.innerHTML = '<div class="pv-empty">Aucun thesaurus trouvé pour ce sandbox — aucun import avec alignement terminologique n\'a encore été effectué.</div>';
    return;
  }

  const nResolved = resolvedTypeElement.length + resolvedSlotValues.length;
  const nPending  = pending.length;
  const nManual   = [...resolvedTypeElement, ...resolvedSlotValues]
    .filter(a => _pvThesOrigin(a.confidence).kind === 'manual').length;
  const nImport   = nResolved - nManual;

  let html = '';

  if (!hasFilter) {
    html += `<div class="pv-empty" style="margin-bottom:12px">Origine du projet non résolue (<code>_import</code> absent ou illisible dans le fichier source) — filtrage par pertinence impossible, thesaurus complet du sandbox affiché ci-dessous.</div>`;
  }

  // ── Resolved (✅) ───────────────────────────────────────────────
  // _pvResolvedRows stores rows in render order so that pvThesUnconfirm(i)
  // (called by index, cf. inline onclick) can retrieve shard/term/
  // sourceImport without re-escaping these values in the HTML — same
  // pattern as _pvPendingRows below.
  _pvResolvedRows = [
    ...resolvedTypeElement.map(a => ({ ...a, kind: 'type_element' })),
    ...resolvedSlotValues.map(a => ({ ...a, kind: 'slot_value' })),
  ];

  html += `<div style="margin-bottom:16px">
    <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">✅ Resolved alignments (${nResolved}) — <span style="color:var(--text-muted);font-weight:400;text-transform:none;letter-spacing:0">📥 ${nImport} à l'import · ✍️ ${nManual} validé(s) manuellement</span></div>`;
  if (nResolved) {
    html += `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="border-bottom:1px solid var(--border)">
        <th style="text-align:left;padding:4px 8px;color:var(--text-muted);font-weight:600">Terme projet</th>
        <th style="text-align:left;padding:4px 8px;color:var(--text-muted);font-weight:600">→ KB</th>
        <th style="text-align:left;padding:4px 8px;color:var(--text-muted);font-weight:600">Confiance</th>
        <th style="text-align:left;padding:4px 8px;color:var(--text-muted);font-weight:600">Origine</th>
        <th style="text-align:left;padding:4px 8px;color:var(--text-muted);font-weight:600"></th>
      </tr></thead>
      <tbody>
        ${_pvResolvedRows.map((a, i) => `
        <tr style="border-bottom:1px solid var(--border-light)">
          <td style="padding:4px 8px;color:var(--text-secondary)">${a.term}</td>
          <td style="padding:4px 8px;color:var(--accent);font-family:'JetBrains Mono',monospace">${a.kind === 'type_element' ? `type_element = ${a.target}` : `${a.slot} = ${a.value}`}</td>
          <td style="padding:4px 8px;color:var(--success);font-size:11px">${a.confidence || ''}</td>
          <td style="padding:4px 8px;font-size:11px">${_pvThesOriginBadge(a.confidence, a.sourceImport)}</td>
          <td style="padding:4px 8px;white-space:nowrap">${_pvThesOrigin(a.confidence).kind === 'manual'
            ? `<button class="btn btn-ghost" style="font-size:11px;padding:2px 8px;color:var(--text-muted)" onclick="pvThesUnconfirm(${i})" title="Remet ce terme en attente de confirmation">↩️ Annuler</button>`
            : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  } else {
    html += `<div class="pv-empty">Aucun alignement résolu trouvé pour ce projet.</div>`;
  }
  html += `</div>`;

  // ── Unresolved (⚠️ Pending) ─────────────────────────────────────
  // Inline resolution: each row has ✅ Confirm / ❌ Reject buttons —
  // cf. pvThesToggleConfirm/pvThesConfirm/pvThesReject below.
  // _pvPendingRows stores rows in render order so that handlers
  // (called by index, cf. inline onclick) can retrieve shard/term/
  // sourceImport without re-escaping these values in the HTML.
  _pvPendingRows = pending;

  html += `<div style="margin-bottom:16px">
    <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">⚠️ En attente de confirmation (${nPending})</div>`;
  if (nPending) {
    html += `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="border-bottom:1px solid var(--border)">
        <th style="text-align:left;padding:4px 8px;color:var(--text-muted);font-weight:600">Terme projet</th>
        <th style="text-align:left;padding:4px 8px;color:var(--text-muted);font-weight:600">Mapping proposé</th>
        <th style="text-align:left;padding:4px 8px;color:var(--text-muted);font-weight:600">Action</th>
      </tr></thead>
      <tbody>${pending.map((p, i) => `
        <tr style="border-bottom:1px solid var(--border-light)">
          <td style="padding:4px 8px;color:var(--text-secondary)">${p.term}</td>
          <td style="padding:4px 8px;color:var(--warn);font-family:'JetBrains Mono',monospace;font-size:11px">${p.proposed || ''}</td>
          <td style="padding:4px 8px;white-space:nowrap">
            <button class="btn btn-ghost" style="font-size:11px;padding:2px 8px;color:var(--success)" onclick="pvThesToggleConfirm(${i})" id="pv-thes-confirm-btn-${i}">✅ Confirmer</button>
            <button class="btn btn-ghost" style="font-size:11px;padding:2px 8px;color:var(--error)" onclick="pvThesReject(${i})">❌ Rejeter</button>
          </td>
        </tr>
        <tr id="pv-thes-confirm-row-${i}" hidden style="border-bottom:1px solid var(--border-light)">
          <td colspan="3" style="padding:8px;background:var(--bg-elevated)">
            <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
              <div>
                <label style="display:block;font-size:10px;color:var(--text-muted);margin-bottom:2px">type_element *</label>
                <input class="form-input" style="font-size:12px;padding:4px 8px;width:220px" id="pv-thes-te-${i}" value="${_pvGuessTypeElement(p.proposed)}">
              </div>
              <div>
                <label style="display:block;font-size:10px;color:var(--text-muted);margin-bottom:2px">slot (optionnel)</label>
                <input class="form-input" style="font-size:12px;padding:4px 8px;width:160px" id="pv-thes-slot-${i}" value="${_pvGuessSlotHint(p.proposed).slot}">
              </div>
              <div>
                <label style="display:block;font-size:10px;color:var(--text-muted);margin-bottom:2px">value (optionnel)</label>
                <input class="form-input" style="font-size:12px;padding:4px 8px;width:160px" id="pv-thes-val-${i}" value="${_pvGuessSlotHint(p.proposed).value}">
              </div>
              <button class="btn btn-primary" style="font-size:11px;padding:4px 10px" onclick="pvThesConfirm(${i})">Valider</button>
              <button class="btn btn-ghost" style="font-size:11px;padding:4px 10px" onclick="pvThesToggleConfirm(${i})">Annuler</button>
            </div>
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  } else {
    html += `<div class="pv-empty">Aucun terme en attente de confirmation pour ce projet.</div>`;
  }
  html += `</div>`;

  panel.innerHTML = html;
}

// ── Inline resolution of Pending rows (Thesaurus tab, Project view) ──
let _pvPendingRows = [];
let _pvResolvedRows = []; // populated by renderPvThesaurusTab — see pvThesUnconfirm below

// Extracts a candidate type_element from the "Proposed KB mapping" text
// (e.g. "type_element: chiffrement_authentifie ? (nom_mecanisme: GCM-SIV)"
// → "chiffrement_authentifie") — pre-fill only, the engineer is free
// to correct before confirming.
function _pvGuessTypeElement(proposed) {
  if (!proposed) return '';
  const m = proposed.match(/type_element:\s*([a-zA-Z_][\w]*)/i);
  return m ? m[1] : '';
}

// Extracts a candidate slot/value pair from the first parenthesised group
// "(slot: value)" found in the proposed text — used to pre-fill the
// optional "Aliases — slot values" row when the proposed mapping already
// suggests one (common case: "(nom_mecanisme: GCM-SIV)").
function _pvGuessSlotHint(proposed) {
  if (!proposed) return { slot: '', value: '' };
  const m = proposed.match(/\(([a-zA-Z_][\w]*)\s*:\s*([^)?]+?)\s*\)/);
  return m ? { slot: m[1], value: m[2].trim() } : { slot: '', value: '' };
}

function pvThesToggleConfirm(i) {
  const row = document.getElementById(`pv-thes-confirm-row-${i}`);
  if (row) row.hidden = !row.hidden;
}

async function pvThesReject(i) {
  const p = _pvPendingRows[i];
  if (!p || !currentSandbox) return;
  if (!confirm(`Classer "${p.term}" en hors-périmètre (Out-of-scope) ?`)) return;
  await _pvThesSubmitResolve({
    shard: p.shard, term: p.term, sourceImport: p.sourceImport, action: 'reject',
    scope:       p.scope || undefined,   // colonne 4 de * Pending (null → 'global' côté serveur)
    projectId:   currentProject?.id,
    entityId:    currentProject?.entity,
    projectName: currentProject?.name,
  });
}

async function pvThesConfirm(i) {
  const p = _pvPendingRows[i];
  if (!p || !currentSandbox) return;
  const typeElement = document.getElementById(`pv-thes-te-${i}`)?.value.trim();
  if (!typeElement) { alert('type_element requis pour confirmer.'); return; }
  const slot  = document.getElementById(`pv-thes-slot-${i}`)?.value.trim();
  const value = document.getElementById(`pv-thes-val-${i}`)?.value.trim();
  await _pvThesSubmitResolve({
    shard: p.shard, term: p.term, sourceImport: p.sourceImport, action: 'confirm',
    typeElement, slot: slot || undefined, value: value || undefined,
    scope:       p.scope || undefined,   // colonne 4 de * Pending (null → 'global' côté serveur)
    projectId:   currentProject?.id,
    entityId:    currentProject?.entity,
    projectName: currentProject?.name,
  });
}

async function _pvThesSubmitResolve(body) {
  try {
    const r = await fetch(`${API}/api/sandboxes/${currentSandbox.id}/thesaurus/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'Échec de la résolution');
    // Invalidate the tab cache for this project and re-render from the
    // freshly written org file (no optimistic in-memory update —
    // we re-read the source of truth to remain reliable even when
    // multiple rows point to the same term).
    const cacheKey = `${currentSandbox.id}/${currentProject.entity}/${currentProject.id}`;
    delete _pvThesaurusCache[cacheKey];
    renderPvThesaurusTab();
  } catch (err) {
    alert(`Erreur : ${err.message}`);
  }
}

// Undoes a manual confirmation (webapp-only — server refuses this on an
// alias resolved at import time, see chorus/thesaurus.js §
// unconfirmThesaurusAlias). Moves the alias back to * Pending so it can be
// re-confirmed differently or rejected.
async function pvThesUnconfirm(i) {
  const a = _pvResolvedRows[i];
  if (!a || !currentSandbox) return;
  if (!confirm(`Annuler la confirmation manuelle de "${a.term}" et la remettre en attente ?`)) return;
  try {
    const r = await fetch(`${API}/api/sandboxes/${currentSandbox.id}/thesaurus/unconfirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shard: a.shard, term: a.term, sourceImport: a.sourceImport,
        projectId:   currentProject?.id,
        entityId:    currentProject?.entity,
        projectName: currentProject?.name,
      }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'Échec de l\'annulation');
    const cacheKey = `${currentSandbox.id}/${currentProject.entity}/${currentProject.id}`;
    delete _pvThesaurusCache[cacheKey];
    renderPvThesaurusTab();
  } catch (err) {
    alert(`Erreur : ${err.message}`);
  }
}


// ── Actions depuis la page projet ────────────────────────────
function pvRunPipeline() {
  if (currentProject) selectProjectPipeline(currentProject.id);
}
function pvReimport() {
  if (currentProject) openImportModal(currentProject.id);
}
function pvTerminal() {
  if (!currentProject || !currentSandbox) return;
  openLevelTerminal('project', {
    sbId: currentSandbox.id, entityId: currentProject.entity,
    projId: currentProject.id, projName: currentProject.name,
  });
}

// ── Breadcrumb navigation ────────────────────────────────────
function bcGoSandbox() {
  if (!currentSandbox) { goHome(); return; }
  // Masquer breadcrumb projet
  document.getElementById('bc-project').hidden = true;
  document.getElementById('bc-entity').hidden  = true;
  document.getElementById('bc-sep1').hidden    = true;
  document.getElementById('bc-sep2').hidden    = true;
  document.getElementById('bc-sandbox').textContent = currentSandbox.name;
  // Recharger la page sandbox
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-sandbox').classList.add('active');
  if (currentEntityId) renderProjectsTab();
}

// ─── RECENT PROJECTS ──────────────────────────────────────────
function relDate(dateStr) {
  if (!dateStr) return '—';
  const diff = Math.round((Date.now() - new Date(dateStr)) / 86400000);
  if (diff === 0) return "aujourd'hui";
  if (diff === 1) return 'hier';
  if (diff < 7)   return `il y a ${diff}j`;
  if (diff < 30)  return `il y a ${Math.round(diff / 7)}sem`;
  return `il y a ${Math.round(diff / 30)}mois`;
}

function renderRecentProjects(maxItems = 6) {
  const TYPE_ICON = { pdf: '📄', docx: '📝', zip: '🗜️' };
  const all = [];
  SANDBOXES.forEach(sb => {
    (PROJECTS[sb.id] || []).forEach(p => {
      if (p.state !== 'imported' && p.state !== 'importing') return;
      const ents = (typeof ENTITIES !== 'undefined' ? ENTITIES[sb.id] : null) || [];
      const ent  = ents.find(e => e.id === p.entity);
      all.push({ ...p, _sb: sb, _entityLabel: ent ? ent.label : (p.entity || '—') });
    });
  });

  // Tri : importing en tête, puis par lastRun desc
  all.sort((a, b) => {
    if (a.state === 'importing' && b.state !== 'importing') return -1;
    if (b.state === 'importing' && a.state !== 'importing') return  1;
    if (!a.lastRun && !b.lastRun) return 0;
    if (!a.lastRun) return  1;
    if (!b.lastRun) return -1;
    return new Date(b.lastRun) - new Date(a.lastRun);
  });

  const recent = all.slice(0, maxItems);

  const countEl = document.getElementById('recent-count');
  if (countEl) countEl.textContent = all.length > maxItems ? `${all.length} au total` : '';

  const strip = document.getElementById('recent-projects-strip');
  if (!strip) return;

  if (recent.length === 0) {
    strip.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:4px 0">Aucun projet traité récemment</div>';
    return;
  }

  strip.innerHTML = recent.map(p => {
    const dotColor   = p.state === 'importing' ? 'var(--warn)' : 'var(--success)';
    const typeIcon   = TYPE_ICON[p.type] || '📁';
    const sbShort    = p._sb.name.split(/[\s\/·]/)[0]; // premier mot
    const entityShort = p._entityLabel.length > 16 ? p._entityLabel.slice(0, 14) + '…' : p._entityLabel;

    let compBadge;
    if (p.state === 'importing') {
      compBadge = `<span class="recent-comp-badge none">⏳ ${p.progress || 0}%</span>`;
    } else if (p.compliance != null) {
      const cls = p.compliance >= 80 ? 'high' : p.compliance >= 50 ? 'mid' : 'low';
      compBadge = `<span class="recent-comp-badge ${cls}">${p.compliance}%</span>`;
    } else {
      compBadge = `<span class="recent-comp-badge none">—</span>`;
    }

    return `
      <div class="recent-card"
           onclick="openRecentProject('${p._sb.id}','${p.entity}','${p.id}')"
           title="${p.name} · ${p._sb.name}">
        <div class="recent-card-sb">
          <span class="recent-card-sb-icon">${p._sb.icon}</span>
          <span class="recent-card-sb-name">${sbShort}</span>
          <span>·</span>
          <span class="recent-card-sb-entity">${entityShort}</span>
        </div>
        <div class="recent-card-name">${typeIcon} ${p.name}</div>
        <div class="recent-card-footer">
          <span class="recent-state-dot" style="background:${dotColor}" title="${p.state}"></span>
          ${compBadge}
          <span class="recent-date">${relDate(p.lastRun)}</span>
        </div>
      </div>`;
  }).join('');
}

function openRecentProject(sbId, entityId, projId) {
  // Positionner le sandbox courant sans déclencher la navigation sandbox
  currentSandbox  = SANDBOXES.find(s => s.id === sbId);
  currentEntityId = entityId || null;
  if (currentSandbox && projId) selectProject(projId);
  else if (currentSandbox)      selectSandbox(sbId);
}

// ─── GLOBAL DASHBOARD ─────────────────────────────────────────
function renderGlobalDashboard() {
  renderRecentProjects(6);

  const container = document.getElementById('sandbox-cards');
  container.innerHTML = SANDBOXES.map(sb => {
    const gaugePct  = sb.compliance_avg != null ? sb.compliance_avg
                    : (sb.projects_total > 0 ? Math.round(sb.projects_imported / sb.projects_total * 100) : 0);
    const gaugeLabel = sb.compliance_avg != null ? 'avg compliance' : 'import coverage';
    const barColor   = gaugePct >= 80 ? 'var(--success)' : gaugePct >= 50 ? 'var(--warn)' : 'var(--error)';

    const compAvgHtml = sb.compliance_avg != null
      ? `<span style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:16px;color:${barColor}">${sb.compliance_avg}%</span>`
      : `<span style="color:var(--text-muted)">—</span>`;

    const lastRunHtml = sb.last_run
      ? `<button class="btn btn-ghost btn-sm" style="font-family:'JetBrains Mono',monospace;font-size:11px;padding:2px 6px;border-color:transparent"
           title="Ouvrir le rapport du dernier run (${sb.last_run})"
           onclick="event.stopPropagation(); goToLastRun('${sb.id}')">${sb.last_run}</button>`
      : `<span style="color:var(--text-muted);font-size:11px">—</span>`;

    return `
      <div class="sb-overview-card" onclick="selectSandbox('${sb.id}')">
        <div class="sb-ov-header">
          <div class="sb-ov-icon" style="background:${sb.color}22;font-size:18px">${sb.icon}</div>
          <div style="min-width:0;flex:1">
            <div class="sb-ov-title">${sb.name}</div>
            ${sb.desc ? `<div class="sb-ov-desc"><span style="font-size:11px;color:var(--text-muted)">${sb.desc}</span></div>` : ''}
          </div>
          <button class="btn btn-ghost btn-sm" style="margin-left:auto;flex-shrink:0"
            title="Terminal ECA — sandbox ${sb.id}"
            onclick="event.stopPropagation(); openLevelTerminal('sandbox', {sbId:'${sb.id}'})">🖥️</button>
        </div>
        <div class="sb-ov-stats">
          <div class="sb-ov-stat">
            <div class="sov-val">${sb.projects_imported}<span style="font-size:12px;color:var(--text-muted)">/${sb.projects_total}</span></div>
            <div class="sov-key">Imported</div>
          </div>
          <div class="sb-ov-stat">
            <div class="sov-val">${compAvgHtml}</div>
            <div class="sov-key">Conformité moy.</div>
          </div>
          <div class="sb-ov-stat" style="align-items:flex-end">
            <div style="line-height:1.2">${lastRunHtml}</div>
            <div class="sov-key">Last run</div>
          </div>
        </div>
        <div class="compliance-bar" title="${gaugeLabel} : ${gaugePct}%">
          <div class="bar" style="width:${gaugePct}%;background:${barColor}"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ─── GO TO LAST RUN ────────────────────────────────────────────
// Navigue vers le sandbox → scope l'entity du dernier run → ouvre le
// pipeline modal du projet → pré-affiche le panneau de rapports existants.
function goToLastRun(sbId) {
  const sb = SANDBOXES.find(s => s.id === sbId);
  if (!sb || !sb.last_run_entity || !sb.last_run_project) {
    // Aucun run connu : simplement naviguer vers le sandbox
    selectSandbox(sbId);
    return;
  }

  // 1. Naviguer vers le sandbox (sélectionne la page, met à jour la sidebar)
  selectSandbox(sbId);

  // 2. Restreindre la vue au contexte (entity) du dernier run
  selectEntity(sb.last_run_entity);

  // 3. Trouver le projet du dernier run et pré-charger ses rapports
  const proj = (PROJECTS[sbId] || []).find(p => p.id === sb.last_run_project);
  if (!proj) return;

  // Pre-load _lastReports with the most recent run.pl report for the project
  // (the pipeline execution panel shows the generated report, not the
  // full history — which remains available via the Reports tab).
  const runReports = sortReportsByDateDesc((proj.reports || []).filter(r => r.kind === 'run'));
  const latestRunReport = runReports.length ? [runReports[0]] : [];
  if (latestRunReport.length) {
    window._lastReports = latestRunReport;
  }

  // 4. Ouvrir le pipeline modal pour ce projet
  selectProjectPipeline(sb.last_run_project);

  // 5. Immediately show the reports panel with the last existing run
  if (latestRunReport.length) {
    const reportsPanel = document.getElementById('pipeline-reports');
    if (reportsPanel) {
      reportsPanel.style.display = 'block';
      renderReportsList(latestRunReport);
    }
  }
}

// ─── SIDEBAR ──────────────────────────────────────────────────
function renderSidebar() {
  const list = document.getElementById('sidebar-list');
  list.innerHTML = SANDBOXES.map(sb => `
    <div class="sandbox-item" id="sb-item-${sb.id}" onclick="selectSandbox('${sb.id}')">
      <div class="sb-icon" style="background:${sb.color}22">${sb.icon}</div>
      <div class="sb-info">
        <div class="sb-name">${sb.name}</div>
        <div class="sb-meta">${sb.projects_imported}/${sb.projects_total} proj</div>
      </div>
    </div>
  `).join('');
}

// ─── GO HOME (logo click) ──────────────────────────────────────
// Returns to the global dashboard (one card per sandbox in the central panel)
// — without reloading the page, reusing the grid already populated by
// initFromServer() (#sandbox-cards is never cleared elsewhere).
function goHome() {
  currentSandbox  = null;
  currentProject  = null;
  currentEntityId = null;
  document.querySelectorAll('.sandbox-item').forEach(el => el.classList.remove('active'));
  const bc = document.getElementById('bc-sandbox');
  if (bc) bc.textContent = 'Dashboard';
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-global').classList.add('active');
}

// ─── SELECT SANDBOX ───────────────────────────────────────────
function selectSandbox(id) {
  currentSandbox = SANDBOXES.find(s => s.id === id);
  currentProject = null;
  currentEntityId = null; // no entity selected by default
  // Reset fold state for the new sandbox (start collapsed)
  window._ctxExpandState = {};

  // Update sidebar
  document.querySelectorAll('.sandbox-item').forEach(el => el.classList.remove('active'));
  document.getElementById('sb-item-' + id)?.classList.add('active');

  // Update breadcrumb
  document.getElementById('bc-sandbox').textContent = currentSandbox.name;

  // Switch pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-sandbox').classList.add('active');

  // Fill detail
  document.getElementById('sb-detail-name').textContent = currentSandbox.name;
  document.getElementById('sb-detail-desc').textContent = currentSandbox.standard + ' — ' + currentSandbox.desc;

  // Reset to projects tab
  switchTab('projects');
  renderProjectsTab();

  // Reset corpus / pipeline
  document.getElementById('corpus-select-hint').style.display = 'block';
  document.getElementById('corpus-content').style.display = 'none';
  document.getElementById('pipeline-select-hint').style.display = 'block';
  document.getElementById('pipeline-content').style.display = 'none';
}

// ─── ENTITY SELECTION (scopes the project view to a single entity) ────────
function selectEntity(entityId) {
  currentEntityId = entityId;
  renderProjectsTab();
}

function clearEntitySelection() {
  currentEntityId = null;
  renderProjectsTab();
}

// ─── PROJECTS TAB ─────────────────────────────────────────────
function renderProjectsTab() {
  if (!currentSandbox) return;
  const sbId = currentSandbox.id;
  const projs = PROJECTS[sbId] || [];
  const entities = ENTITIES[sbId] || [];

  // Bouton "+ Import project" : visible dès qu'au moins une entity existe
  // dans ce sandbox — PAS conditionné à currentEntityId. Avant ce correctif,
  // le bouton restait masqué tant qu'aucune entity n'était "sélectionnée",
  // mais la seule façon de sélectionner une entity était de cliquer sur un
  // groupe déjà affiché dans la liste — lui-même seulement rendu s'il
  // contenait au moins un projet (cf. renderEntityGroup ci-dessous, appelé
  // uniquement `if (grp.length)`). Une entity tout juste créée (dossier
  // workspace/<entity>/{sources,reports} vides, cf. createEntity()) n'avait
  // donc aucun point d'entrée pour y importer un premier projet — bug
  // découvert en conditions réelles sur le sandbox 08 (entity "test").
  // openImportModal() peuple déjà entièrement son <select id="import-context">
  // depuis ENTITIES[sbId] (toutes les entities, y compris vides) — seul le
  // bouton était en cause, pas la modal elle-même.
  const importBtnWrap = document.getElementById('import-project-btn-wrap');
  if (importBtnWrap) importBtnWrap.style.display = entities.length ? 'inline-block' : 'none';

  // Bandeau de scope — visible uniquement quand une entity est sélectionnée.
  // Les autres entities n'apparaissent alors plus du tout dans le panel.
  const scopeBar = document.getElementById('entity-scope-bar');
  if (scopeBar) {
    if (currentEntityId) {
      const ent = entities.find(e => e.id === currentEntityId);
      const label = ent ? ent.label : currentEntityId;
      const entPath = ent ? ent.path : `workspace/${currentEntityId}`;
      scopeBar.style.display = 'flex';
      scopeBar.innerHTML = `
        <button class="btn btn-ghost btn-sm" onclick="clearEntitySelection()">← Sandbox</button>
        <span class="entity-folder">${label}</span>
        <span class="entity-path">${entPath}/</span>
        <button class="btn btn-ghost btn-sm" title="Terminal ECA — entity ${label}" onclick="openLevelTerminal('entity', {sbId:'${sbId}', entityId:'${currentEntityId}', entityLabel:'${label}'})">🖥️</button>
      `;
    } else {
      scopeBar.style.display = 'none';
      scopeBar.innerHTML = '';
    }
  }

  // Importing section — filtrée par entity si une entity est sélectionnée
  const importingAll = projs.filter(p => p.state === 'importing');
  const importing = currentEntityId ? importingAll.filter(p => p.entity === currentEntityId) : importingAll;
  const impSection = document.getElementById('importing-section');
  impSection.style.display = importing.length ? 'block' : 'none';
  document.getElementById('importing-list').innerHTML = importing.length
    ? `<div class="proj-grid">${importing.map(p => projCard(p)).join('')}</div>`
    : '';

  // ── Sandbox vide : aucun projet du tout ──────────────────────
  if (projs.length === 0) {
    const ctx0 = entities[0];
    const entityPathEx = ctx0 ? `$workspace/${sbId}/${ctx0.path}/` : `$workspace/${sbId}/workspace/default/`;
    document.getElementById('imported-list').innerHTML = `
      <div class="empty-state" style="padding:36px 0 20px">
        <div class="es-icon">📭</div>
        <div class="es-title">Sandbox vide</div>
        <div class="es-sub">Aucun projet dans ce sandbox pour l'instant.</div>
        <div class="es-sub" style="margin-top:6px;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-muted)">${entityPathEx}</div>
      </div>`;
    document.getElementById('available-list').innerHTML = '';
    return;
  }

  const importedAll  = projs.filter(p => p.state === 'imported');
  const availableAll = projs.filter(p => p.state === 'available');
  const imported  = currentEntityId ? importedAll.filter(p => p.entity === currentEntityId)  : importedAll;
  const available = currentEntityId ? availableAll.filter(p => p.entity === currentEntityId) : availableAll;

  const _ctxExpandState = window._ctxExpandState || (window._ctxExpandState = {});

  function renderEntityGroup(list, entityId, section) {
    const ctx = entities.find(c => c.id === entityId);
    const label = ctx ? ctx.label : entityId;
    const ctxPath = ctx ? `$workspace/${sbId}/${ctx.path}/` : `$workspace/${sbId}/workspace/${entityId}/`;
    const count = list.length;
    const key = `${sbId}__${section}__${entityId}`;
    // Collapsed by default unless user explicitly expanded it
    const collapsed = _ctxExpandState[key] !== true;
    const colClass = collapsed ? ' collapsed' : '';
    return `
      <div class="entity-group${colClass}" id="entityg-${key.replace(/[^a-z0-9]/gi,'_')}">
        <div class="entity-header" style="cursor:pointer" title="Sélectionner cette entity"
             onclick="selectEntity('${entityId}')">
          <span class="entity-chevron" onclick="event.stopPropagation(); toggleEntityGroup('${key}')">▼</span>
          <span class="entity-folder">${label}</span>
          <span class="entity-path">${ctxPath}</span>
          <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${count} projet${count > 1 ? 's' : ''}</span>
          <button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:10px" title="Terminal ECA — entity ${label}" onclick="event.stopPropagation(); openLevelTerminal('entity', {sbId:'${sbId}', entityId:'${entityId}', entityLabel:'${label}'})">🖥️</button>
        </div>
        <div class="entity-proj-grid">
          ${sortByLastRun(list).map(p => projCard(p)).join('')}
        </div>
      </div>
    `;
  }

  // Scoped to a single entity: no more grouping — other entities no longer
  // appear in the panel at all. Rendered as a compact list (1 row/project)
  // rather than a grid of tall cards: avoids unnecessary vertical scrolling
  // when there is plenty of horizontal space but grid cards were tall
  // (multiple action rows).
  // Tri par date d'import décroissante (le plus récemment importé en premier)
  // Fallback : lastRun si importDate absent, puis en dernier si aucun
  const sortByLastRun = list => [...list].sort((a, b) => {
    const da = a.importDate || a.lastRun || null;
    const db = b.importDate || b.lastRun || null;
    if (!da && !db) return 0;
    if (!da) return  1;
    if (!db) return -1;
    return db > da ? 1 : db < da ? -1 : 0;
  });

  if (currentEntityId) {
    document.getElementById('imported-list').innerHTML = imported.length
      ? `<div class="proj-list">${sortByLastRun(imported).map(p => projRow(p)).join('')}</div>`
      : `<div class="empty-state"><div class="es-icon">📂</div><div class="es-title">Aucun projet importé</div><div class="es-sub">Cliquez "Import project" pour commencer</div></div>`;

    const availableSection = document.getElementById('available-section');
    if (available.length) {
      availableSection.style.display = 'block';
      document.getElementById('available-list').innerHTML =
        `<div class="proj-list">${sortByLastRun(available).map(p => projRow(p)).join('')}</div>`;
    } else {
      // Rien à afficher : on masque toute la section (titre inclus) pour
      // ne pas gaspiller d'espace vertical avec une info redondante.
      availableSection.style.display = 'none';
      document.getElementById('available-list').innerHTML = '';
    }
    return;
  }

  // Vue multi-entities : masquer la section "Available" si la liste est vide.
  document.getElementById('available-section').style.display = available.length ? 'block' : 'none';

  // Vue multi-entities (aucune sélection) — groupes collapsibles par entity
  const entityOrder = entities.map(c => c.id);
  const allEntityIds = [...new Set([...entityOrder, ...projs.map(p => p.entity || '_none')])];

  let importedHtml = '';
  if (imported.length === 0) {
    importedHtml = `<div class="empty-state"><div class="es-icon">📂</div><div class="es-title">Aucun projet importé</div><div class="es-sub">Sélectionnez une entity pour importer un projet</div></div>`;
  } else {
    for (const entityId of allEntityIds) {
      const grp = imported.filter(p => (p.entity || '_none') === entityId);
      if (grp.length) importedHtml += renderEntityGroup(grp, entityId, 'imp');
    }
  }
  document.getElementById('imported-list').innerHTML = importedHtml;

  let availableHtml = '';
  for (const entityId of allEntityIds) {
    const grp = available.filter(p => (p.entity || '_none') === entityId);
    if (grp.length) availableHtml += renderEntityGroup(grp, entityId, 'avail');
  }
  document.getElementById('available-list').innerHTML = availableHtml;
}

// ─── AUDIT IMPORT ───────────────────────────────────────────────
// Calcule le bouton d'action contextuelle selon l'état d'audit du projet.
//   compact=true  → bouton court pour projCard / projRow (sp = stopPropagation prefix)
//   compact=false → bouton + guidance texte pour le panel aperçu
// Retourne le bouton d'action contextuelle audit :
//   compact=true  → court (card/row) — pas de Pipeline (déjà présent dans pc-actions)
//   compact=false → full (panel aperçu) — guidance texte si gaps résiduels
// entityId : optionnel — requis pour afficher le bouton "📄 Rapport" en mode full
function auditNextAction(audit, projId, compact, sp = '', entityId = null) {
  if (!audit) {
    // Jamais audité
    return compact
      ? `<button class="btn btn-ghost btn-sm" onclick="${sp}startAudit('${projId}')" title="Lancer l'audit import (chorus-audit-import)">🔬</button>`
      : `<button class="btn btn-ghost btn-sm" onclick="startAudit('${projId}')" style="font-size:11px">🔬 Auditer</button>`;
  }
  if (audit.gapsComblables > 0 && !audit.patchApplied) {
    // Corrections comblables disponibles
    return compact
      ? `<button class="btn btn-ghost btn-sm" onclick="${sp}startAudit('${projId}', true)" title="Appliquer ${audit.gapsComblables} correction(s) comblable(s) (--patch)">✅ ${audit.gapsComblables}</button>`
      : `<button class="btn btn-ghost btn-sm" onclick="startAudit('${projId}', true)" style="font-size:11px">✅ Patch (${audit.gapsComblables})</button>`;
  }
  // Plus de comblables — guidance contextuelle (pas de Pipeline, déjà disponible)
  if (compact) return ''; // rien à afficher en vue compacte
  const steps = [];
  if (audit.gapsPartiels > 0)
    steps.push(`<div style="font-size:11px;color:var(--text-muted);margin-top:5px">⚠️ <strong>${audit.gapsPartiels}</strong> élément(s) partiels — pages source incomplètes. Identifier les éléments concernés dans le rapport, extraire les pages manquantes, relancer <code>chorus-import-project</code>, puis <code>chorus-audit-import</code>.</div>`);
  if (audit.gapsMapping > 0)
    steps.push(`<div style="font-size:11px;color:var(--text-muted);margin-top:5px">🔄 <strong>${audit.gapsMapping}</strong> mapping(s) à confirmer — termes du document non reconnus par le KB. Enrichir le KB (<code>chorus-feed --enrich</code>) ou confirmer manuellement dans le rapport d'audit, puis relancer <code>chorus-audit-import</code>.</div>`);
  if (audit.framesManquantes > 0)
    steps.push(`<div style="font-size:11px;color:var(--text-muted);margin-top:5px">🚫 <strong>${audit.framesManquantes}</strong> type(s) de Frame manquant(s) dans le KB — ces éléments ne peuvent pas être classifiés. Consulter le rapport d'audit pour les identifiants concernés, puis ajouter les Frames manuellement au JSON.</div>`);
  if (audit.gapsAbsents > 0)
    steps.push(`<div style="font-size:11px;color:var(--text-muted);margin-top:5px">❌ <strong>${audit.gapsAbsents}</strong> élément(s) structurellement absents du document source — hors périmètre. Aucune action requise.</div>`);
  // Bouton rapport détaillé (si rapport disponible et contexte connu)
  if (audit.report && entityId) {
    const rpParts = audit.report.replace(/\\/g, '/').split('/');
    const rpFile  = rpParts[rpParts.length - 1];
    const sbId    = currentSandbox ? currentSandbox.id : '';
    steps.push(`<button class="btn btn-ghost btn-sm" style="margin-top:8px;font-size:11px" onclick="openMdView('${sbId}','${entityId}','${projId}','${rpFile}')" title="${audit.report}">📄 Rapport détaillé</button>`);
  }
  return steps.join('');
}

// Rendu du badge _audit (chorus-audit-import) sur les cartes de projets importés.
// audit = null → Non audité  |  audit.run=true + 0 gaps → Audité OK
//              | gaps > 0    → N gaps (comblables/partiels/mapping/frames manquantes)
function renderAuditBadge(audit) {
  if (!audit) {
    return `<span class="badge audit-none" title="Audit import non effectué (chorus-audit-import)">🔬 Non audité</span>`;
  }
  const actionable = (audit.gapsComblables || 0) + (audit.gapsPartiels || 0)
                   + (audit.gapsMapping || 0)  + (audit.framesManquantes || 0);
  if (actionable === 0) {
    const d = audit.date ? ` · ${audit.date}` : '';
    return `<span class="badge audit-ok" title="Audit import OK${d}">🔬 Audité</span>`;
  }
  const parts = [];
  if (audit.gapsComblables)   parts.push(`✅ ${audit.gapsComblables} comblable${audit.gapsComblables > 1 ? 's' : ''}`);
  if (audit.gapsPartiels)     parts.push(`⚠️ ${audit.gapsPartiels} partiel${audit.gapsPartiels > 1 ? 's' : ''}`);
  if (audit.gapsMapping)      parts.push(`🔄 ${audit.gapsMapping} mapping${audit.gapsMapping > 1 ? 's' : ''}`);
  if (audit.framesManquantes) parts.push(`🚫 ${audit.framesManquantes} frame${audit.framesManquantes > 1 ? 's' : ''} manquante${audit.framesManquantes > 1 ? 's' : ''}`);
  const tip = parts.join(' · ') + (audit.date ? ` · ${audit.date}` : '');
  return `<span class="badge audit-gaps" title="${tip}">🔬 ${actionable} gap${actionable > 1 ? 's' : ''}</span>`;
}

// Lance chorus-audit-import via le terminal ECA sandbox (même pattern que
// runTestingStrategy). Le refreshSandboxReports est déclenché automatiquement
// par levelTerminalExec après la fin de session (DONE) — le badge _audit se
// met à jour sans action supplémentaire.
function startAudit(projId, withPatch = false) {
  const sb   = currentSandbox;
  const proj = (PROJECTS[sb.id] || []).find(p => p.id === projId);
  if (!proj) return;
  // projId = slug complet, ex. "project-proj-1234" — le fichier est workspace/<entity>/<projId>.json
  const relFile  = `workspace/${proj.entity}/${projId}.json`;
  const patchFlag = withPatch ? ' --patch' : '';
  const cmd = `chorus-audit-import ${sb.id} ${relFile}${patchFlag}`;
  openLevelTerminal('sandbox', { sbId: sb.id }, cmd);
}

function projCard(p) {
  const typeIcons = { pdf: '📄', docx: '📝', zip: '🗜️', url: '🌐' };
  const sp = `event.stopPropagation();`;
  if (p.state === 'importing') {
    return `
      <div class="proj-card importing" style="cursor:pointer" onclick="selectProject('${p.id}')">
        <div class="pc-header">
          <div>
            <div class="pc-name">${typeIcons[p.type] || '📁'} ${p.name}</div>
            <div class="pc-id">${p.id}</div>
          </div>
          <span class="badge importing">⏳ Importing</span>
        </div>
        <div class="pc-meta">chorus-import-project — session ECA réelle en cours</div>
      </div>
    `;
  }
  if (p.state === 'available') {
    return `
      <div class="proj-card not-imported" style="cursor:pointer" onclick="selectProject('${p.id}')">
        <div class="pc-header">
          <div>
            <div class="pc-name">${typeIcons[p.type] || '📁'} ${p.name}</div>
            <div class="pc-id">${p.id}</div>
          </div>
          <span class="badge pending">Not imported</span>
        </div>
        <div class="pc-actions">
          <button class="btn btn-ghost btn-sm" onclick="${sp}quickImport('${p.id}')">↑ Import</button>
        </div>
      </div>
    `;
  }
  // imported
  const comp = p.compliance;
  const compColor = comp >= 90 ? 'var(--success)' : comp >= 75 ? 'var(--warn)' : 'var(--error)';
  const auditBadge = renderAuditBadge(p.audit || null);
  const auditBtn = auditNextAction(p.audit || null, p.id, true, sp, p.entity || '');
  return `
    <div class="proj-card imported" style="cursor:pointer" onclick="selectProject('${p.id}')">
      <div class="pc-header">
        <div>
          <div class="pc-name">${typeIcons[p.type] || '📁'} ${p.name}</div>
          <div class="pc-id">${p.id}</div>
        </div>
        <div style="display:flex;gap:4px;align-items:center">
          ${auditBadge}
          <span class="badge imported">✓ Imported</span>
        </div>
      </div>
      <div class="pc-meta" style="display:flex;gap:12px">
        <span><span style="color:var(--accent)" class="mono">${p.frames}</span> frames</span>
        <span><span style="color:var(--info)" class="mono">${p.evidence}</span> evidence</span>
        <span style="color:${compColor};font-weight:600" class="mono">${comp}%</span>
      </div>
      <div class="pc-meta" style="margin-top:4px">Last run: ${p.lastRun}</div>
      <div class="pc-actions">
        <button class="btn btn-success btn-sm" onclick="${sp}selectProjectPipeline('${p.id}')">▶ Pipeline</button>
        <button class="btn btn-ghost" style="font-size:11px" onclick="${sp}openImportModal('${p.id}')">↺ Ré-importer</button>
        ${auditBtn}
        <button class="btn btn-ghost" style="font-size:11px" onclick="${sp}openHistoryModal('${p.id}')" title="Rapports : ${reportCountLabel(p.reports)}">📋 ${reportCountLabel(p.reports)}</button>
        <button class="btn btn-ghost" style="font-size:11px" title="Terminal ECA — projet ${p.id}" onclick="${sp}openLevelTerminal('project', {sbId: currentSandbox.id, entityId: '${p.entity}', projId: '${p.id}', projName: '${(p.name||'').replace(/'/g,"\\'")}'})">🖥️</button>
      </div>
    </div>
  `;
}

// ─── PROJECT ROW ────────────────────────────────────────────────
// Compact 1-row/project rendering — used in the "scoped entity" view to
// avoid unnecessary scrolling through a grid of tall cards when there is
// plenty of horizontal space but limited height (cf. request: avoid
// vertical scrolling when the panel has room).
function projRow(p) {
  const typeIcons = { pdf: '📄', docx: '📝', zip: '🗜️', url: '🌐' };
  const icon = typeIcons[p.type] || '📁';
  const sp = `event.stopPropagation();`;

  if (p.state === 'importing') {
    return `
      <div class="proj-row importing" style="cursor:pointer" onclick="selectProject('${p.id}')">
        <span class="pr-name">${icon} ${p.name}</span>
        <span class="pr-id">${p.id}</span>
        <span class="pr-meta">chorus-import-project — session ECA réelle en cours</span>
        <span class="badge importing">⏳ Importing</span>
      </div>
    `;
  }
  if (p.state === 'available') {
    return `
      <div class="proj-row not-imported" style="cursor:pointer" onclick="selectProject('${p.id}')">
        <span class="pr-name">${icon} ${p.name}</span>
        <span class="pr-id">${p.id}</span>
        <span class="pr-meta"><span class="badge pending">Not imported</span></span>
        <span class="pr-actions">
          <button class="btn btn-ghost btn-sm" onclick="${sp}quickImport('${p.id}')">↑ Import</button>
        </span>
      </div>
    `;
  }
  // imported
  const comp = p.compliance;
  const compColor = comp >= 90 ? 'var(--success)' : comp >= 75 ? 'var(--warn)' : 'var(--error)';
  const auditBadgeRow = renderAuditBadge(p.audit || null);
  const auditBtnRow = auditNextAction(p.audit || null, p.id, true, sp, p.entity || '');
  return `
    <div class="proj-row imported" style="cursor:pointer" onclick="selectProject('${p.id}')">
      <span class="pr-name" title="${p.name}">${icon} ${p.name}</span>
      <span class="pr-id" title="${p.id}">${p.id}</span>
      <span class="pr-meta">
        <span><span style="color:var(--accent)" class="mono">${p.frames}</span> frames</span>
        <span><span style="color:var(--info)" class="mono">${p.evidence}</span> evidence</span>
        <span style="color:${compColor};font-weight:600" class="mono">${comp}%</span>
        <span>Last run: ${p.lastRun}</span>
      </span>
      <span class="pr-actions">
        <button class="btn btn-success btn-sm" onclick="${sp}selectProjectPipeline('${p.id}')">▶ Pipeline</button>
        <button class="btn btn-ghost btn-sm" onclick="${sp}openImportModal('${p.id}')" title="Ré-importer">↺</button>
        ${auditBtnRow}
        <button class="btn btn-ghost btn-sm" onclick="${sp}openHistoryModal('${p.id}')" title="Rapports : ${reportCountLabel(p.reports)}">📋 ${reportCountLabel(p.reports)}</button>
        <button class="btn btn-ghost btn-sm" title="Terminal ECA — projet ${p.id}" onclick="${sp}openLevelTerminal('project', {sbId: currentSandbox.id, entityId: '${p.entity}', projId: '${p.id}', projName: '${(p.name||'').replace(/'/g,"\\'")}'})">🖥️</button>
      </span>
    </div>
  `;
}

// ─── TABS ─────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    const names = ['projects', 'tests'];
    b.classList.toggle('active', names[i] === name);
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  // Chargement paresseux — pas besoin de fetch, les données testing/kbModeled
  // sont déjà portées par currentSandbox (cf. buildSandboxEntry).
  if (name === 'tests') renderTestingTab();
}

function toggleEntityGroup(key) {
  if (!window._ctxExpandState) window._ctxExpandState = {};
  const expanded = window._ctxExpandState[key] === true;
  window._ctxExpandState[key] = !expanded;
  const id = 'entityg-' + key.replace(/[^a-z0-9]/gi, '_');
  const el = document.getElementById(id);
  if (el) el.classList.toggle('collapsed', expanded); // if was expanded → collapse
}

// ─── TAB: TESTS (project-rules-iso/edges/cross/scale — sandbox root) ───
//
// 4 fixed strategies generated by chorus-create-project --strategy <slug>
// (cf. chorus-create-project.md § ID prefix and strategy reference):
//   iso   → project-rules-iso.json  — each rule tested in isolation
//   edges → project-edges.json     — threshold boundary values (threshold ± ε)
//   cross → project-cross.json     — multi-rule interactions
//   scale → project-scale.json     — volume stress (≥100 elements)
//
// Execution ALWAYS via chorus-check (never run.pl directly) — chorus-check
// triggers the diagnostic/reinforcement loop if the run does not give the
// expected result (cf. chorus-check.md), which a bare run.pl would miss.
// Launch therefore always goes through a sandbox-level ECA terminal with
// a pre-filled auto-executed chorus-check command.
const TESTING_META = {
  iso:   { label: 'Rules (iso)',  icon: '🧩', desc: 'Chaque règle testée isolément — 1 cas conforme + 1 cas non-conforme par règle.' },
  edges: { label: 'Edges',        icon: '📐', desc: 'Valeurs aux limites — seuil exact et seuil ± ε pour chaque slot continu.' },
  cross: { label: 'Cross-rules',  icon: '🔀', desc: 'Interactions entre règles — éléments déclenchant plusieurs règles simultanément.' },
  scale: { label: 'Scale',        icon: '📊', desc: 'Stress volumétrique — ≥ 100 éléments, tous types/classes, calibrage _MAX_CYCLES.' },
};
let _testsSelected = new Set();

// Lightweight README data cache (resolved bugs) per sandbox — reuses the
// same endpoint as the Corpus panel (/api/sandboxes/:sbId/corpus) to avoid
// duplicating the parsing already done in chorus.js § parseSandboxReadme.
// If _sbcData is already loaded for this sandbox (Corpus panel opened in the
// same session), it is reused directly without a re-fetch.
const _testingBugsCache = {};

async function fetchTestingBugs(sbId) {
  if (_testingBugsCache[sbId] !== undefined) return _testingBugsCache[sbId];
  // Immediate reuse if the Corpus panel has already loaded this sandbox.
  if (_sbcData && currentSandbox?.id === sbId && _sbcData.readme) {
    _testingBugsCache[sbId] = _sbcData.readme;
    return _sbcData.readme;
  }
  try {
    const r = await fetch(`${API}/api/sandboxes/${sbId}/corpus`);
    if (!r.ok) { _testingBugsCache[sbId] = null; return null; }
    const { corpus } = await r.json();
    _testingBugsCache[sbId] = corpus?.readme || null;
  } catch {
    _testingBugsCache[sbId] = null;
  }
  return _testingBugsCache[sbId];
}

// Badge de convergence réelle — distinct du statut SOLVED/FAILED et du
// décompte brut conforme/non-conforme : un test "iso" attend volontairement
// des NON_CONFORME (1 cas conforme + 1 cas non-conforme par règle), donc
// "converger" ne veut PAS dire "0 NON_CONFORME" mais "les verdicts
// CONFORME/NON_CONFORME obtenus sont ceux attendus" (0 discordance).
// Source : $SANDBOX/.last-check-results.json produit par `chorus-check --all`
// (cf. Engine/agent/skills/chorus-check.md § 6-all.6, chorus/scanner.js §
// readLastCheckResults). `convergence` est `null` si ce fichier n'existe pas
// (jamais lancé en mode --all, ou invalidé par un chorus-feed depuis).
function renderConvergenceBadge(slug, convergence) {
  if (!convergence) {
    return `<div style="font-size:10px;color:var(--text-muted);font-style:italic">Convergence inconnue — lancez chorus-check --all</div>`;
  }
  const { discordances, stale, source } = convergence;
  const staleTag = stale
    ? ` <span style="color:var(--warn)" title="La KB a été modifiée depuis ce résultat (chorus-feed) — à relancer">⚠️ obsolète</span>`
    : '';
  // Pas de date ici — déjà affichée juste au-dessus (ligne SOLVED/FAILED,
  // r.date) : ce badge décrit la même exécution, redondant de la répéter.
  // `source: 'run-report'` = calculé côté webapp depuis le dernier run-report
  // de CE fichier (fallback quand .last-check-results.json est absent/ne
  // couvre pas ce fichier — cf. chorus/reports.js § computeConvergenceFromRunReport).
  // Moins autoritaire qu'un `chorus-check --all` réel (pas de rule_id par
  // discordance, pas de détection "stale" vs agent/.kb-hash) — signalé
  // discrètement, sans bloquer l'affichage du badge de convergence lui-même.
  const sourceTag = source === 'run-report'
    ? ` <span style="color:var(--text-muted)" title="Calculé depuis le dernier run-report de ce fichier — lancez chorus-check --all pour le détail par règle (rule_id) et la détection KB obsolète">·🧮</span>`
    : '';

  // Le badge ne reflète QUE les discordances (expected ≠ got) — jamais le
  // compteur "unprocessed" : un élément non traité n'est pas en soi un écart
  // de convergence (il peut s'agir d'un Frame de contrôle technique du
  // pipeline, hors périmètre de test -OK-/-KO-, cf. pipeline_control) et ne
  // doit pas assombrir un résultat par ailleurs sans aucune discordance.
  if (!discordances) {
    return `<div style="font-size:11px;font-weight:700;color:var(--success)">✅ Converge${staleTag}${sourceTag}</div>`;
  }

  const detail = `${discordances} discordance${discordances > 1 ? 's' : ''}`;

  return `<div style="font-size:11px;font-weight:700;color:var(--warn)">⚠️ ${detail}${staleTag}${sourceTag}</div>`;
}

// ─── CONVERGENCE LOOP INDICATOR ──────────────────────────────────────────
// 4 états basés sur testing + strengthenReport :
//   Converged       : tous les tests existants ont 0 discordance + 0 unprocessed
//   Gaps detected   : discordances > 0 ET rapport strengthen présent (→ propose chorus-fix)
//   Strengthen needed : discordances > 0 MAIS pas de rapport strengthen à jour
//   Not run         : aucun test généré ou jamais exécuté
function renderConvergenceIndicator(testing, strengthenReport, kbModeled) {
  const slugs = Object.keys(testing).filter(s => testing[s]);
  if (!slugs.length || !kbModeled) return '';

  const withConvergence = slugs.filter(s => testing[s]?.convergence);
  if (!withConvergence.length) {
    return `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;background:var(--bg-tertiary);margin-bottom:14px;font-size:12px;flex-wrap:wrap">
      <span style="color:var(--text-muted)">⬜</span>
      <span style="color:var(--text-muted)">Tests non exécutés</span>
      <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="runTestingSelection()"
        title="Lance chorus-check --all sur tous les tests générés">
        🖥️ chorus-check --all
      </button>
    </div>`;
  }

  const totalDisc = withConvergence.reduce((s, k) => s + (testing[k].convergence?.discordances || 0), 0);
  const totalUnproc = withConvergence.reduce((s, k) => s + (testing[k].convergence?.unprocessed || 0), 0);
  const anyStale = withConvergence.some(k => testing[k].convergence?.stale);

  if (totalDisc === 0 && totalUnproc === 0 && !anyStale) {
    return `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;background:rgba(34,197,94,.08);margin-bottom:14px;font-size:12px">
      <span>✅</span>
      <span style="color:var(--success);font-weight:600">Convergé</span>
      <span style="color:var(--text-muted)">— 0 discordance, 0 unprocessed sur ${withConvergence.length} test(s)</span>
    </div>`;
  }

  // Rapport strengthen présent et frais ?
  const reportFresh = strengthenReport && !strengthenReport.stale && strengthenReport.totalGaps > 0;
  const reportStale = strengthenReport && strengthenReport.stale;

  if (reportFresh) {
    const bB = strengthenReport.summary?.bucket_b || 0;
    const bC = strengthenReport.summary?.bucket_c || 0;
    const bA = strengthenReport.summary?.bucket_a || 0;
    return `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;background:rgba(251,146,60,.08);margin-bottom:14px;font-size:12px;flex-wrap:wrap">
      <span>⚠️</span>
      <span style="color:var(--warn);font-weight:600">${strengthenReport.totalGaps} gap(s) détecté(s)</span>
      <span style="color:var(--text-muted)">B:${bB} C:${bC} A:${bA}</span>
      ${bB + bC > 0 ? `<button class="btn btn-ghost btn-sm" style="font-size:11px;margin-left:4px" onclick="confirmRunChorusFix('dry-run')" title="Prévisualise les patches YAML sans écrire">🛠️ Appliquer (dry-run)</button>` : ''}
      <span style="color:var(--text-muted);font-size:10px;margin-left:auto">${(strengthenReport.timestamp || '').replace('T', ' ').slice(0, 16)}</span>
    </div>`;
  }

  if (totalDisc > 0) {
    const staleNote = reportStale ? ' · rapport périmé' : '';
    return `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;background:rgba(251,146,60,.08);margin-bottom:14px;font-size:12px;flex-wrap:wrap">
      <span>🔄</span>
      <span style="color:var(--warn);font-weight:600">${totalDisc} discordance(s)${staleNote}</span>
      <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="runStrengthenFull()"
        title="Analyse toutes les discordances de la suite complète — opération longue (chorus-strengthen)">
        🔧 Analyser avec chorus-strengthen
      </button>
    </div>`;
  }

  // unprocessed > 0 uniquement
  return `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;background:rgba(251,146,60,.08);margin-bottom:14px;font-size:12px">
    <span>⚠️</span>
    <span style="color:var(--warn);font-weight:600">${totalUnproc} élément(s) non traité(s)</span>
    <span style="color:var(--text-muted)">— vérifiez Feed.pm %SLOTS_REQUIS</span>
  </div>`;
}

// ─── STRENGTHEN GAP PANEL ─────────────────────────────────────────────────
// Panneau affiché sous les cartes de test quand un rapport strengthen est présent.
function renderStrengthenPanel(report, sbId) {
  if (!report || report.totalGaps === 0) {
    if (report && report.totalGaps === 0) {
      return `<div class="pv-panel" style="margin-top:18px;font-size:12px">
        <div style="font-weight:600;margin-bottom:6px">📋 Rapport de renforcement</div>
        <div style="color:var(--success)">✅ Aucun gap détecté${report.stale ? ' <span style="color:var(--text-muted)">(périmé — relancez chorus-strengthen)</span>' : ''}.</div>
      </div>`;
    }
    return '';
  }

  const bB = report.summary?.bucket_b || 0;
  const bC = report.summary?.bucket_c || 0;
  const bA = report.summary?.bucket_a || 0;
  const staleNote = report.stale
    ? `<span style="font-size:10px;color:var(--warn);margin-left:8px">⚠️ périmé — KB modifiée depuis</span>`
    : '';
  const ts = (report.timestamp || '').replace('T', ' ').slice(0, 16);

  const gapRows = report.gaps.map(g => {
    const bucketColor = g.bucket === 'B' ? 'var(--info)' : g.bucket === 'C' ? 'var(--warn)' : 'var(--text-muted)';
    const blockedBadge = g.blocked
      ? `<span style="font-size:9px;color:var(--error);margin-left:4px">🛑 bloqué</span>` : '';
    return `<details style="font-size:11px;border-bottom:1px solid var(--border);padding:4px 0">
      <summary style="cursor:pointer;display:flex;align-items:center;gap:6px">
        <span style="color:${bucketColor};font-weight:700;min-width:14px">${g.bucket}</span>
        <span style="color:var(--text-muted)">#${g.id}</span>
        <span>${g.gap_type?.replace(/_/g, ' ') || '?'}</span>
        <span style="color:var(--text-muted)">·</span>
        <span style="font-family:'JetBrains Mono',monospace">${g.element_id || '?'}</span>
        ${blockedBadge}
      </summary>
      <div style="padding:6px 0 2px 20px;color:var(--text-secondary)">
        <div><strong>Règle :</strong> ${g.rule_file || '—'} <span style="color:var(--text-muted)">(${g.agent || '?'})</span></div>
        <div><strong>Attendu :</strong> ${g.expected || '?'} → <strong>Obtenu :</strong> ${g.got || '?'}</div>
        ${g.hypothesis ? `<div><strong>Hypothèse :</strong> ${g.hypothesis}</div>` : ''}
        ${g.corpus_ref ? `<div><strong>Réf corpus :</strong> ${g.corpus_ref}</div>` : ''}
      </div>
    </details>`;
  }).join('');

  const blockedCount = report.gaps.filter(g => g.blocked).length;
  const blockedWarning = blockedCount > 0
    ? `<div style="font-size:11px;color:var(--warn);margin-bottom:8px">⚠️ ${blockedCount} patch(es) bloqué(s) par la garde anti-régression — révision manuelle requise.</div>`
    : '';

  const fixBtns = (bB + bC > 0) ? `
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="confirmRunChorusFix('dry-run')"
        title="Prévisualise les patches YAML et les corpus-correctif sans rien écrire">
        🛠️ Dry-run (prévisualiser)
      </button>
      ${bB > 0 ? `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="confirmRunChorusFix('bucket-b')"
        title="Applique les patches YAML Bucket B après confirmation">
        ⚡ Appliquer Bucket B (${bB} règle(s) YAML)
      </button>` : ''}
      ${bC > 0 ? `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="confirmRunChorusFix('bucket-c')"
        title="Génère corpus-correctif.txt et lance chorus-feed --enrich pour les gaps Bucket C">
        📄 Générer corpus-correctif (${bC} règle(s) manquante(s))
      </button>` : ''}
    </div>` : '';

  return `<div class="pv-panel" style="margin-top:18px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-weight:600;font-size:12px">📋 Rapport de renforcement</span>
      ${staleNote}
      <span style="font-size:10px;color:var(--text-muted);margin-left:auto">${ts}</span>
    </div>
    <div style="display:flex;gap:14px;margin-bottom:10px;font-size:12px">
      <span title="Ajustements YAML directs">🔧 Bucket B : <strong>${bB}</strong></span>
      <span title="Règles manquantes — chorus-feed --enrich">📄 Bucket C : <strong>${bC}</strong></span>
      <span title="Clarification corpus requise — révision humaine">🔍 Bucket A : <strong>${bA}</strong></span>
    </div>
    ${blockedWarning}
    <div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;padding:4px 8px">
      ${gapRows}
    </div>
    ${fixBtns}
  </div>`;
}

// ─── FIX HISTORY PANEL ───────────────────────────────────────────────────
// Panneau affiché dans l'onglet Tests quand .last-fix-history.json existe.
// Panneau log chorus-fix — déplié sur demande (collapsed par défaut).
// Séparé volontairement du compteur "🎯 N gaps KB résolus" (README.org)
// qui est un cumulatif historique multi-sessions.
function renderFixHistoryPanel(report) {
  if (!report) return '';

  // Construit tous les runs (dernier en tête + précédents à la suite) pour
  // éviter une hiérarchie confuse "run courant / runs précédents".
  const allRuns = [report, ...(report.previousRuns || [])];
  const totalResolved = allRuns.reduce((s, r) => s + (r.gaps_resolved || 0), 0);
  const totalApplied  = allRuns.reduce((s, r) =>
    s + (r.patches || []).filter(p => p.status === 'applied').length, 0);

  // ── En-tête toujours visible ───────────────────────────────────────────
  // Montre le résumé en un coup d'œil sans ouvrir le panneau.
  const summaryBadge = totalResolved > 0
    ? `<span style="font-size:11px;color:var(--success);font-weight:600">
         ✓ ${totalResolved} gap${totalResolved > 1 ? 's' : ''} résolu${totalResolved > 1 ? 's' : ''}</span>`
    : `<span style="font-size:11px;color:var(--text-muted)">0 gap résolu</span>`;

  const runCount = allRuns.length;
  const runLabel = `${runCount} run${runCount > 1 ? 's' : ''}`;
  const lastTs   = (report.timestamp || '').replace('T', ' ').slice(0, 16);

  // ── Ligne de détail par run ────────────────────────────────────────────
  const _runRow = (r, idx) => {
    const rTs      = (r.timestamp || '').replace('T', ' ').slice(0, 16);
    const rApp     = (r.patches || []).filter(p => p.status === 'applied').length;
    const rBlk     = (r.patches || []).filter(p => p.status === 'blocked').length;
    const rSkp     = (r.patches || []).filter(p => p.status === 'skipped').length;
    const rDry     = r.dry_run
      ? `<span style="font-size:9px;padding:1px 4px;background:rgba(99,102,241,.15);color:var(--info);border-radius:3px">dry-run</span>`
      : '';
    const rDelta   = (r.gaps_before != null && r.gaps_after != null)
      ? `<span style="color:var(--text-muted)">${r.gaps_before} gap${r.gaps_before !== 1 ? 's' : ''} → ${r.gaps_after} gap${r.gaps_after !== 1 ? 's' : ''}</span>`
      : '';
    const rResolved = (r.gaps_resolved || 0) > 0
      ? `<span style="color:var(--success)">✓ ${r.gaps_resolved} résolu${r.gaps_resolved > 1 ? 's' : ''}</span>`
      : `<span style="color:var(--text-muted)">0 résolu</span>`;

    // Patches de ce run
    // Détecte si un patch porte sur un seuil numérique de conformité.
    // Pattern: >=N→>=M, >N→>M, <=N→<=M, ou mots-clés bits/niveau/seuil/taille.
    const _isThresholdPatch = (p) => {
      if (!p.change) return false;
      if (/>=?\d+\s*[→>-]+\s*>=?\d+/.test(p.change)) return true;
      if (/<=?\d+\s*[→>-]+\s*<=?\d+/.test(p.change)) return true;
      if (/\b(bits?|niveau|seuil|taille|score|longueur)\b/i.test(p.change)) return true;
      return false;
    };

    const patchRows = (r.patches || []).map(p => {
      const stIcon  = p.status === 'applied' ? '✅' : p.status === 'blocked' ? '🛑' : '⏭';
      const stColor = p.status === 'applied' ? 'var(--success)' : p.status === 'blocked' ? 'var(--error)' : 'var(--text-muted)';
      const isThreshold = _isThresholdPatch(p);
      const thresholdWarn = isThreshold
        ? `<span style="font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600;
               background:rgba(239,68,68,.12);color:var(--error);border:1px solid rgba(239,68,68,.3);
               margin-left:4px" title="Seuil numérique de conformité modifié — validation humaine requise">
             ⚠️ seuil</span>`
        : '';
      return `<details style="font-size:11px;border-bottom:1px solid var(--border-light);padding:3px 0${isThreshold ? ';background:rgba(239,68,68,.04)' : ''}">
        <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;gap:5px">
          <span style="color:${stColor}">${stIcon}</span>
          <span style="color:var(--text-muted)">#${p.gap_id}</span>
          <span>${(p.gap_type || '?').replace(/_/g, ' ')}</span>
          <span style="color:var(--text-muted)">·</span>
          <code style="font-size:10px">${p.element_id || '?'}</code>
          ${thresholdWarn}
        </summary>
        <div style="padding:4px 0 2px 20px;color:var(--text-secondary);font-size:10.5px">
          ${p.rule_file ? `<div>Règle : <code>${p.rule_file}</code>${p.agent ? ` <span style="color:var(--text-muted)">(${p.agent})</span>` : ''}</div>` : ''}
          ${p.change    ? `<div>Patch : <code>${p.change}</code>${isThreshold ? `<span style="font-size:10px;color:var(--error);margin-left:6px">— seuil de conformité : validation humaine requise (voir chorus-fix.md § SECURITY GUARD)</span>` : ''}</div>` : ''}
          ${p.blocked_reason ? `<div style="color:var(--error)">Bloqué : ${p.blocked_reason}</div>` : ''}
        </div>
      </details>`;
    }).join('') || `<div style="font-size:11px;color:var(--text-muted);padding:2px 0">Aucun patch dans ce run.</div>`;

    const ccLine = r.corpus_correctif
      ? `<div style="font-size:11px;margin-top:4px;color:var(--text-muted)">📄 ${r.corpus_correctif}</div>` : '';
    const bALine = (r.bucket_a_count || 0) > 0
      ? `<div style="font-size:11px;margin-top:2px;color:var(--text-muted)">🔍 ${r.bucket_a_count} item(s) Bucket A — clarification corpus requise</div>` : '';
    const borderStyle = idx === 0
      ? 'border-left:3px solid var(--accent);'
      : 'border-left:3px solid var(--border);opacity:.8;';

    return `
      <div style="padding:8px 10px;margin-bottom:8px;background:var(--bg-elevated);border-radius:6px;${borderStyle}">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
          <span style="font-size:11px;font-weight:600;color:var(--text-primary)">${idx === 0 ? 'Dernier run' : `Run ${runCount - idx}`}</span>
          ${rDry}
          <span style="font-size:10px;color:var(--text-muted)">${rTs}</span>
          <span style="margin-left:auto;display:flex;gap:8px;font-size:11px;align-items:center">
            ${rDelta}
            ${rResolved}
          </span>
        </div>
        <div style="font-size:10.5px;color:var(--text-muted);margin-bottom:4px">
          ✅ ${rApp} appliqué${rApp > 1 ? 's' : ''} · 🛑 ${rBlk} bloqué${rBlk > 1 ? 's' : ''} · ⏭ ${rSkp} ignoré${rSkp > 1 ? 's' : ''}
        </div>
        <div style="border:1px solid var(--border);border-radius:4px;padding:2px 6px;max-height:180px;overflow-y:auto">
          ${patchRows}
        </div>
        ${ccLine}${bALine}
      </div>`;
  };

  const runsHtml = allRuns.map((r, i) => _runRow(r, i)).join('');

  return `<div class="pv-panel" style="margin-top:10px">
    <div style="display:flex;align-items:center;gap:8px;cursor:pointer"
         onclick="toggleFixHistoryPanel(this)">
      <span class="cov-chevron">▸</span>
      <span style="font-weight:600;font-size:12px">🛠️ chorus-fix</span>
      <span style="font-size:11px;color:var(--text-muted)">${runLabel} · dernier : ${lastTs}</span>
      ${summaryBadge}
    </div>
    <div class="fix-history-body hidden" style="margin-top:8px">
      <div style="font-size:10.5px;color:var(--text-muted);margin-bottom:8px;padding:4px 8px;
                  background:var(--bg-elevated);border-radius:4px;border:1px solid var(--border-light)">
        ℹ️ Log technique des runs <code>chorus-fix</code> sur ce sandbox — distinct du
        compteur <em>🎯 gaps KB résolus</em> ci-dessus qui totalise l'ensemble des
        corrections documentées dans <code>README.org § Session notes</code>.
      </div>
      ${runsHtml}
    </div>
  </div>`;
}

function toggleFixHistoryPanel(header) {
  const body    = header.closest('.pv-panel').querySelector('.fix-history-body');
  const chevron = header.querySelector('.cov-chevron');
  body.classList.toggle('hidden');
  if (chevron) chevron.classList.toggle('open');
}

// ─── STRENGTHEN FULL-SUITE LAUNCHER ──────────────────────────────────────
// Déclenché depuis l'indicateur de convergence (suite complète, pas un seul slug).
function runStrengthenFull() {
  if (!currentSandbox) return;
  const sb = currentSandbox;

  const already = (_activeTerminalsCache || [])
    .find(t => t.sbId === sb.id && t.kind === 'strengthen');
  if (already) {
    alert(
      `Un chorus-strengthen est déjà en cours sur ce sandbox ` +
      `(depuis ${Math.round((already.elapsedMs || 0) / 60000)} min).\n\n` +
      `Attendez sa fin avant d'en relancer un.`
    );
    return;
  }

  if (!confirm(
    `Lancer chorus-strengthen sur la suite complète du sandbox « ${sb.id} » ?\n\n` +
    `⚠️ Opération longue (plusieurs dizaines de minutes), très consommatrice de CPU.\n` +
    `Un seul chorus-strengthen à la fois est autorisé par sandbox (timeout : 45 min).\n\n` +
    `Continuer ?`
  )) return;

    openLevelTerminal('sandbox', { sbId: sb.id, kind: 'strengthen' },
      `chorus-strengthen ${sb.id}`);
  }
  
  // Lance chorus-check --all sans dépendre de _testsSelected (utilisé par Zone 2
  // boucle de convergence KB — étapes ① et ④). Si un seul projet existe, lance
  // chorus-check sur ce fichier ; sinon toujours --all.
  function runCheckAll() {
    if (!currentSandbox) return;
    const sb = currentSandbox;
    const existingSlugs = Object.keys(TESTING_META).filter(s => (sb.testing || {})[s]);
    if (!existingSlugs.length) return;
    const cmd = existingSlugs.length === 1
      ? `chorus-check ${sb.id} ${TESTING_FILES[existingSlugs[0]]}`
      : `chorus-check ${sb.id} --all`;
    openLevelTerminal('sandbox', { sbId: sb.id }, cmd);
  }

// ─── CHORUS-FIX LAUNCHER ──────────────────────────────────────────────────
function confirmRunChorusFix(mode) {
  if (!currentSandbox) return;
  const sb = currentSandbox;
  const report = sb.strengthenReport;

  if (!report || report.totalGaps === 0) {
    alert('Aucun gap à corriger. Lancez chorus-strengthen d\'abord.');
    return;
  }
  if (report.stale) {
    if (!confirm('⚠️ Le rapport de renforcement est périmé (KB modifiée depuis).\nLancez chorus-strengthen à nouveau pour un diagnostic à jour.\n\nContinuer quand même ?')) return;
  }

  const bB = report.summary?.bucket_b || 0;
  const bC = report.summary?.bucket_c || 0;
  const blockedCount = (report.gaps || []).filter(g => g.blocked).length;
  const blockedNote = blockedCount > 0
    ? `\n\n⚠️ ${blockedCount} patch(es) sont bloqués par la garde anti-régression et ne seront PAS appliqués automatiquement.` : '';

  if (mode === 'dry-run') {
    openLevelTerminal('sandbox', { sbId: sb.id, kind: 'fix' },
      `chorus-fix ${sb.id} --dry-run`);
    return;
  }

  if (mode === 'bucket-b') {
    if (bB === 0) { alert('Aucun gap Bucket B dans le rapport.'); return; }
    if (!confirm(
      `Appliquer ${bB} patch(es) YAML (Bucket B) sur le sandbox « ${sb.id} » ?\n\n` +
      `⚡ Cette action modifie directement des fichiers YAML de règles.${blockedNote}\n\n` +
      `Recommandé : effectuer un dry-run d'abord si ce n'est pas déjà fait.`
    )) return;
    openLevelTerminal('sandbox', { sbId: sb.id, kind: 'fix' },
      `chorus-fix ${sb.id} --bucket-b`);
    return;
  }

  if (mode === 'bucket-c') {
    if (bC === 0) { alert('Aucun gap Bucket C dans le rapport.'); return; }
    if (!confirm(
      `Générer corpus-correctif.txt et lancer chorus-feed --enrich ` +
      `pour ${bC} gap(s) Bucket C sur le sandbox « ${sb.id} » ?\n\n` +
      `📄 Un fichier corpus-correctif-NNN.txt sera créé dans le sandbox, ` +
      `puis chorus-feed --enrich sera lancé automatiquement.\n\n` +
      `Cette opération peut être longue (chorus-feed sur un grand corpus).`
    )) return;
    openLevelTerminal('sandbox', { sbId: sb.id, kind: 'fix' },
      `chorus-fix ${sb.id} --bucket-c`);
  }
}

// ─── ZONE 2 — BOUCLE DE CONVERGENCE KB ───────────────────────────────────
// Remplace renderConvergenceIndicator() + renderStrengthenPanel().
// Affiche 4 étapes linéaires avec état et bouton d'action contextuel.
// Chaque étape n'est actionnable que si l'étape précédente est complétée.
//
//  ① Vérifier   chorus-check --all    ✅/⚠️/○
//  ② Diagnostiquer chorus-strengthen  ✅/⚠️ périmé/○
//  ③ Corriger KB  chorus-fix          ✅/B:N C:N/○
//  ④ Re-vérifier  chorus-check --all  ✅/○  (apparaît après ③ seulement)
function renderKbConvergenceWorkflow(testing, strengthenReport, sbId, kbModeled) {
  if (!kbModeled) return '';

  const slugs = Object.keys(testing).filter(s => testing[s]);
  if (!slugs.length) return '';

  // ── État étape ①  (chorus-check --all) ──────────────────────────────
  const totalDisc    = slugs.reduce((s, k) => s + (testing[k].convergence?.discordances || 0), 0);
  const totalUnproc  = slugs.reduce((s, k) => s + (testing[k].convergence?.unprocessed  || 0), 0);
  const anyStale     = slugs.some(k => testing[k].convergence?.stale);
  const checkTs      = slugs.map(k => testing[k].convergence?.timestamp).filter(Boolean).sort().pop();
  const checkDone    = slugs.some(k => testing[k].convergence);

  let step1State, step1Badge, step1Action = '';
  if (!checkDone) {
    step1State = 'pending';
    step1Badge = `<span style="color:var(--text-muted)">○ jamais lancé</span>`;
    step1Action = `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="runCheckAll()">▶ Vérifier</button>`;
  } else if (anyStale) {
    step1State = 'stale';
    step1Badge = `<span style="color:var(--warn)">⚠️ périmé — résultats obsolètes</span>`;
    step1Action = `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="runCheckAll()">▶ Re-lancer</button>`;
  } else if (totalDisc === 0 && totalUnproc === 0) {
    step1State = 'ok';
    step1Badge = `<span style="color:var(--success)">✅ ${slugs.length} projet(s) convergés</span>
      <span style="color:var(--text-muted);font-size:10px;margin-left:6px">${(checkTs||'').slice(0,16).replace('T',' ')}</span>`;
    step1Action = `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="runCheckAll()">▶ Re-vérifier</button>`;
  } else {
    step1State = 'disc';
    step1Badge = `<span style="color:var(--warn)">⚠️ ${totalDisc} discordance(s)</span>
      <span style="color:var(--text-muted);font-size:10px;margin-left:6px">${(checkTs||'').slice(0,16).replace('T',' ')}</span>`;
    step1Action = `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="runCheckAll()">▶ Re-lancer</button>`;
  }

  // ── État étape ②  (chorus-strengthen) ───────────────────────────────
  const sr = strengthenReport;
  const step2Enabled = (step1State === 'disc' || step1State === 'ok');
  let step2State, step2Badge, step2Action = '', step2Detail = '';
  if (!step2Enabled) {
    step2State = 'waiting';
    step2Badge = `<span style="color:var(--text-muted)">○ en attente de l'étape ①</span>`;
  } else if (!sr) {
    step2State = 'pending';
    step2Badge = `<span style="color:var(--text-muted)">○ jamais analysé</span>`;
    step2Action = `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="runStrengthenFull()">🔍 Diagnostiquer</button>`;
  } else if (sr.stale) {
    step2State = 'stale';
    step2Badge = `<span style="color:var(--warn)">⚠️ périmé — KB modifiée depuis</span>`;
    step2Action = `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="runStrengthenFull()">🔍 Re-analyser</button>`;
  } else {
    const bB = sr.summary?.bucket_b || 0, bC = sr.summary?.bucket_c || 0, bA = sr.summary?.bucket_a || 0;
    const nBugs = (sr.projectBugs || []).length;
    if (sr.totalGaps === 0 && nBugs === 0) {
      step2State = 'ok';
      step2Badge = `<span style="color:var(--success)">✅ 0 gap KB</span>
        <span style="color:var(--text-muted);font-size:10px;margin-left:6px">${(sr.timestamp||'').slice(0,16).replace('T',' ')}</span>`;
    } else {
      step2State = 'gaps';
      const parts = [];
      if (bB) parts.push(`B:${bB}`); if (bC) parts.push(`C:${bC}`); if (bA) parts.push(`A:${bA}`);
      if (nBugs) parts.push(`🔧 ${nBugs} bug(s) fichier`);
      step2Badge = `<span style="color:var(--warn)">⚠️ ${sr.totalGaps} gap(s) KB${nBugs ? ` · ${nBugs} bug(s) fichier` : ''}</span>
        <span style="color:var(--text-muted);font-size:10px;margin-left:6px">${parts.join(' ')} · ${(sr.timestamp||'').slice(0,16).replace('T',' ')}</span>`;
      // Bugs fichier → suggestion ⟲ par stratégie
      if (nBugs) {
        const bugSlugs = [...new Set((sr.projectBugs||[]).map(b => (b.project_file||'').replace('project-','').replace('.json','')))];
        step2Detail += `<div style="font-size:11px;color:var(--warn);margin-top:4px;padding:4px 8px;background:rgba(251,146,60,.08);border-radius:4px">
          🔧 Bug(s) fichier détecté(s) — fix : cliquez ⟲ sur ${bugSlugs.map(s=>`<code>${s}</code>`).join(', ')} (Phase 5b C2–C5 auto)
        </div>`;
      }
    }
    step2Action = `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="runStrengthenFull()">🔍 Re-analyser</button>`;
  }

  // ── État étape ③  (chorus-fix) ───────────────────────────────────────
  const step3Enabled = (step2State === 'gaps');
  const bB = sr?.summary?.bucket_b || 0, bC = sr?.summary?.bucket_c || 0;
  let step3State, step3Badge, step3Action = '';
  if (!step3Enabled) {
    step3State = 'waiting';
    step3Badge = `<span style="color:var(--text-muted)">○ en attente de l'étape ②</span>`;
  } else {
    step3State = 'ready';
    const parts = [];
    if (bB) parts.push(`${bB} règle(s) YAML`); if (bC) parts.push(`${bC} enrichissement(s) KB`);
    step3Badge = `<span style="color:var(--info)">${parts.join(' · ') || '—'}</span>`;
    step3Action = `<span style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="confirmRunChorusFix('dry-run')" title="Prévisualise sans écrire">🛠️ Dry-run</button>
      ${bB ? `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="confirmRunChorusFix('bucket-b')">⚡ B (${bB})</button>` : ''}
      ${bC ? `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="confirmRunChorusFix('bucket-c')">📄 C (${bC})</button>` : ''}
    </span>`;
  }

  // ── État étape ④  (re-vérifier) — visible seulement si ③ actionnable ─
  const step4Visible = (step3State === 'ready' || step3State === 'done');
  const step4Html = step4Visible ? `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:6px;background:var(--bg-secondary);font-size:12px">
      <span style="color:var(--text-muted);font-weight:700;min-width:16px">④</span>
      <span style="min-width:90px">🔄 Re-vérifier</span>
      <code style="font-size:10px;color:var(--text-muted)">chorus-check --all</code>
      <span style="flex:1;color:var(--text-muted)">○ après correction KB</span>
      <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="runCheckAll()">▶ Lancer</button>
    </div>` : '';

  // ── Global : 🏁 Convergé ──────────────────────────────────────────────
  if (step1State === 'ok' && step2State === 'ok') {
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;background:rgba(34,197,94,.1);margin-bottom:14px;font-size:12px">
      <span style="font-size:16px">🏁</span>
      <span style="color:var(--success);font-weight:700">Convergé — KB validée, 0 gap, 0 discordance</span>
    </div>`;
  }

  const stepRow = (n, icon, label, cmd, badge, action, detail='') => `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 12px;border-radius:6px;background:var(--bg-secondary);font-size:12px">
      <span style="color:var(--text-muted);font-weight:700;min-width:16px;padding-top:1px">${n}</span>
      <span style="min-width:90px;white-space:nowrap">${icon} ${label}</span>
      <code style="font-size:10px;color:var(--text-muted);white-space:nowrap">${cmd}</code>
      <span style="flex:1">${badge}</span>
      <span>${action}</span>
    </div>${detail}`;

  return `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">
    <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">Boucle de convergence KB</div>
    ${stepRow('①','▶','Vérifier',    'chorus-check --all', step1Badge, step1Action)}
    ${stepRow('②','🔍','Diagnostiquer','chorus-strengthen',  step2Badge, step2Action, step2Detail)}
    ${stepRow('③','🔧','Corriger KB', 'chorus-fix',          step3Badge, step3Action)}
    ${step4Html}
  </div>`;
}

function renderTestingTab() {

  const sb = currentSandbox;
  const panel = document.getElementById('tab-tests');
  if (!sb || !panel) return;

  const testing           = sb.testing || {};
  const kbModeled         = !!sb.kbModeled;
  const strengthenReport  = sb.strengthenReport || null;
  const fixHistory        = sb.fixHistory        || null;

  const cards = Object.keys(TESTING_META).map(slug => {
    const meta  = TESTING_META[slug];
    const entry = testing[slug]; // null si fichier absent, sinon {file, lastRun, convergence}
    const exists = !!entry;
    const checked = _testsSelected.has(slug);

    // ── Badge unique de statut (WEB-022) ──────────────────────────────
    // Distingue 5 états : ✅ convergé / ⚠️ disc KB / 🔧 bug fichier / ○ non exécuté / ○ non généré
    // Les bugs fichier (C2–C5) viennent de strengthenReport.projectBugs filtré sur ce slug.
    const fileBugsForSlug = (strengthenReport?.projectBugs || [])
      .filter(b => (b.project_file || '').replace('project-','').replace('.json','') === slug);
    const disc = entry?.convergence?.discordances || 0;

    let statusBadge;
    if (!exists) {
      statusBadge = `<span style="font-size:11px;color:var(--text-muted)">○ Pas encore généré</span>`;
    } else if (!entry.lastRun) {
      statusBadge = `<span style="font-size:11px;color:var(--text-muted)">○ Jamais exécuté</span>`;
    } else if (fileBugsForSlug.length > 0) {
      statusBadge = `<span style="font-size:11px;color:var(--warn)">🔧 Bug fichier → cliquez ⟲</span>
        <span style="font-size:10px;color:var(--text-muted);display:block">${fileBugsForSlug.map(b=>b.bug_type).join(', ')}</span>`;
    } else if (disc > 0) {
      statusBadge = `<span style="font-size:11px;color:var(--warn)">⚠️ ${disc} disc. KB — voir boucle ↓</span>`;
    } else {
      statusBadge = `<span style="font-size:11px;color:var(--success)">✅ Convergé</span>`;
    }

    // Run info ligne (compact — SOLVED/FAILED + counts + date)
    let runInfo = '';
    if (exists && entry.lastRun) {
      const r = entry.lastRun;
      const isSolved = r.verdict === 'SOLVED';
      runInfo = `<div style="font-size:10px;color:var(--text-muted);margin-top:2px">
        <span style="color:${isSolved?'var(--success)':'var(--error)'};font-weight:600">${r.verdict}</span>
        · ${r.conformes??0}/${r.totalFrames??0}
        · <span>${(r.date||'').slice(0,16).replace('T',' ')}</span>
      </div>`;
    }

    const statusHtml = `<div style="margin:6px 0">${statusBadge}${runInfo}</div>`;

    // ── Actions : ▶ Lancer + ⟲ Régénérer toujours présents (WEB-022)
    // "🔧 Renforcer" supprimé — déplacé dans Zone 2 (boucle de convergence KB)
    const actionsHtml = exists
      ? `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="runTestingStrategy('${slug}')" title="Lancer chorus-check sur ce fichier projet">▶ Lancer</button>
         <button class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 6px" onclick="regenerateTestingStrategy('${slug}')" title="Régénérer ce test depuis la KB avec corrections C1–C5 automatiques (Phase 5b)">⟲ Regénérer</button>`
      : (kbModeled
          ? `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="generateTestingStrategy('${slug}')">+ Générer</button>`
          : `<button class="btn btn-ghost btn-sm" style="font-size:11px" disabled title="La KB doit être modélisée (chorus-feed) avant de générer des tests">+ Générer</button>`);

    return `
      <div class="pv-panel" style="display:flex;flex-direction:column;gap:4px">
        <div style="display:flex;align-items:center;gap:8px">
          ${exists ? `<input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleTestSelection('${slug}', this.checked)">` : `<span style="width:13px;display:inline-block"></span>`}
          <span style="font-size:15px">${meta.icon}</span>
          <span style="font-weight:600;font-size:13px">${meta.label}</span>
          <span style="margin-left:auto;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-muted)">${entry ? entry.file : TESTING_FILES[slug]}</span>
        </div>
        ${exists && entry.fileDate
          ? `<div style="font-size:10px;color:var(--text-muted);text-align:right;margin-top:-4px">créé le ${entry.fileDate}</div>`
          : ''}
        <div style="font-size:11px;color:var(--text-muted)">${meta.desc}</div>
        ${statusHtml}
        <div>${actionsHtml}</div>
      </div>`;
  }).join('');

  const nExisting = Object.values(testing).filter(Boolean).length;
  const existingSlugsAll = Object.keys(TESTING_META).filter(s => testing[s]);
  const allSelected = nExisting > 0 && existingSlugsAll.every(s => _testsSelected.has(s));
  const kbWarning = kbModeled ? '' : `<div class="pv-empty" style="margin-bottom:12px">⚠️ La KB de ce sandbox n'est pas encore modélisée (<code>agent/chorus/index.org</code> absent) — lancez <code>chorus-feed</code> avant de générer des tests.</div>`;

  panel.innerHTML = `
    ${kbWarning}

    <!-- ══ ZONE 1 — Projets de test ══════════════════════════════════════ -->
    <div style="margin-bottom:18px">
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Projets de test</div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);cursor:${nExisting ? 'pointer' : 'default'}">
          <input type="checkbox" ${allSelected ? 'checked' : ''} ${nExisting === 0 ? 'disabled' : ''} onchange="toggleSelectAllTests(this.checked)">
          Tout sélectionner
        </label>
        <button class="btn btn-primary btn-sm" ${_testsSelected.size === 0 ? 'disabled' : ''} onclick="runTestingSelection()">▶ Lancer la sélection (${_testsSelected.size})</button>
        ${kbModeled ? `<button class="btn btn-ghost btn-sm" onclick="generateAllTests()" title="${nExisting > 0 ? 'Sauvegarde les tests existants puis relance chorus-create-project --batch' : 'Lance chorus-create-project --batch pour générer les 4 tests'}">🔄 ${nExisting > 0 ? 'Re-générer tous' : 'Générer tous'}</button>` : ''}
        ${nExisting > 1 ? `<span style="font-size:11px;color:var(--text-muted)">${nExisting}/4 générés</span>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px">
        ${cards}
      </div>
    </div>

    <!-- ══ ZONE 2 — Boucle de convergence KB ═════════════════════════════ -->
    ${renderKbConvergenceWorkflow(testing, strengthenReport, sb.id, kbModeled)}

    <!-- ══ ZONE 3 — Historique des corrections (chorus-fix) ══════════════ -->
    ${renderFixHistoryPanel(fixHistory)}

    <div id="testing-bugs-section" style="margin-top:18px"></div>
  `;

  // Chargement paresseux (+ cache) des bugs résolus trouvés dans
  // README.org § Session notes — réutilisé depuis le panneau Corpus /
  // Knowledge Base si déjà chargé, sinon fetch dédié. Rendu asynchrone pour
  // ne pas bloquer l'affichage des cartes de tests ci-dessus.
  // Capture strengthen + testing convergence pour le compteur auto
  const _sbStrengthen = strengthenReport;
  const _sbTesting    = testing;
  fetchTestingBugs(sb.id).then(readme => {
    // L'utilisateur a pu changer de sandbox/onglet entre-temps.
    if (currentSandbox?.id !== sb.id) return;
    const section = document.getElementById('testing-bugs-section');
    if (section) section.innerHTML = renderTestingBugsSection(readme, sb.id, _sbStrengthen, _sbTesting);
  });
}

// ─── RESOLVED BUGS — summary card + accordion (cards, grouped by session) ──
// Reuses readme.bugsFixed / readme.bugsTable (parsed by chorus.js §
// parseSandboxReadme from README.org § Session notes). The raw table
// (generic headers/rows, 1st column = "Session" if multi-session) is
// rebuilt here as small cards, more readable than a `|`-separated table,
// grouped by session to give a real debugging history.
let _testingBugsOpen = false;

// Auto-compute resolved bugs from strengthen report when all tests have converged.
// Used as a fallback / supplement when README.org hasn't been updated yet.
// Returns strengthen.totalGaps if: report is fresh (not stale), and every test
// file's convergence shows 0 discordances + 0 unprocessed.
function computeAutoResolvedBugs(strengthenReport, testing) {
  if (!strengthenReport || strengthenReport.stale) return 0;
  if (!strengthenReport.totalGaps) return 0;
  const entries = Object.values(testing || {}).filter(Boolean);
  if (!entries.length) return 0;
  const allConverged = entries.every(e =>
    e.convergence?.converged === true &&
    (e.convergence?.discordances || 0) === 0 &&
    (e.convergence?.unprocessed  || 0) === 0
  );
  return allConverged ? (strengthenReport.totalGaps || 0) : 0;
}

function renderTestingBugsSection(readme, sbId, strengthenReport, testing) {
  // Only Type-2 KB semantic gaps belong in the Tests tab — infrastructure
  // bugs (Type 1, "bloquants") are one-time historical events, not test KPIs.
  const autoCount   = computeAutoResolvedBugs(strengthenReport, testing);
  const kbGaps      = readme?.kbGapsFixed || 0;
  const n           = Math.max(kbGaps, autoCount);
  if (!n) return '';

  // Infrastructure bugs are shown in the KB tab — add a small cross-link here.
  const infraCount  = readme?.infraBugsFixed || 0;
  const infraNote   = infraCount
    ? `<span style="font-size:11px;color:var(--text-muted);margin-left:8px">
         (+ <a onclick="openSandboxCorpusToKb('${sbId}')" style="cursor:pointer;color:var(--text-muted);text-decoration:underline dotted" title="Voir les bugs infrastructure dans l'onglet KB">🔧 ${infraCount} bug${infraCount > 1 ? 's' : ''} infrastructure</a>)
       </span>`
    : '';

  // Detail table : prefer kbGapsTable (explicit README entries). If autoCount
  // is the winning source (strengthen converged but README not yet updated),
  // no detail table is available yet.
  const tbl = (n === kbGaps || (n === autoCount && kbGaps > 0)) ? readme?.kbGapsTable : null;
  const hasSessionCol = tbl && tbl.headers[0] === 'Session';

  // Groups rows by session (if "Session" column present), otherwise
  // a single "Single session" section.
  const groups = new Map();
  if (tbl) {
    tbl.rows.forEach(r => {
      const key   = hasSessionCol ? r[0] : '—';
      const cells = hasSessionCol ? r.slice(1) : r;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(cells);
    });
  }
  const headers = tbl ? (hasSessionCol ? tbl.headers.slice(1) : tbl.headers) : [];

  const cardsHtml = [...groups.entries()].map(([session, rows]) => `
    <div style="margin-bottom:10px">
      ${hasSessionCol ? `<div style="font-size:11px;font-weight:600;color:var(--text-muted);margin:8px 0 6px;display:flex;align-items:center;gap:6px">
        <span style="width:6px;height:6px;border-radius:50%;background:var(--accent);display:inline-block"></span>
        ${session}
      </div>` : ''}
      <div style="display:flex;flex-direction:column;gap:6px">
        ${rows.map(cells => `
          <div style="background:var(--bg-surface);border:1px solid var(--border);border-left:3px solid var(--error,#EF4444);border-radius:6px;padding:8px 10px;font-size:12px">
            ${cells.map((c, i) => headers[i]
              ? `<div style="margin-bottom:${i < cells.length - 1 ? '3' : '0'}px">
                   <span style="color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.03em">${headers[i]}</span>
                   <span style="color:var(--text-secondary);margin-left:4px">${c}</span>
                 </div>`
              : ''
            ).join('')}
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');

  return `
    <div class="pv-panel">
      <div style="display:flex;align-items:center;gap:10px;cursor:pointer" onclick="toggleTestingBugsSection()">
        <span style="font-size:15px">🎯</span>
        <span style="font-weight:600;font-size:13px">${n} gap${n > 1 ? 's' : ''} KB résolu${n > 1 ? 's' : ''}</span>
        <span style="font-size:11px;color:var(--text-muted)">cumulatif · source README.org § Session notes</span>
        ${infraNote}
        <span id="testing-bugs-chevron" class="cov-chevron${_testingBugsOpen ? ' open' : ''}" style="margin-left:auto">▸</span>
      </div>
      <div id="testing-bugs-detail" class="${_testingBugsOpen ? '' : 'hidden'}" style="margin-top:10px">
        ${cardsHtml || `<div class="pv-empty">${autoCount > kbGaps ? `${autoCount} gap${autoCount > 1 ? 's' : ''} résolus (source : .last-strengthen-report.json) — README.org § Session notes pas encore mis à jour.` : 'Détail indisponible — voir README.org § Session notes.'}</div>`}
        <div style="margin-top:4px">
          <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="openSandboxCorpusToKb('${sbId}')">
            📚 Voir dans Knowledge Base
          </button>
        </div>
      </div>
    </div>
  `;
}

function toggleTestingBugsSection() {
  _testingBugsOpen = !_testingBugsOpen;
  document.getElementById('testing-bugs-detail')?.classList.toggle('hidden', !_testingBugsOpen);
  document.getElementById('testing-bugs-chevron')?.classList.toggle('open', _testingBugsOpen);
}

// Cross-link "📚 See in Knowledge Base" — opens the Corpus panel of the
// sandbox and switches directly to the Knowledge Base tab, where the full
// detail (+ KB health, enrichments, final validation) is already rendered
// by openSandboxCorpus() (cf. § SESSION — enrichments + validation).
async function openSandboxCorpusToKb(sbId) {
  if (currentSandbox?.id !== sbId) {
    const sb = SANDBOXES.find(s => s.id === sbId);
    if (sb) currentSandbox = sb;
  }
  await openSandboxCorpus();
  switchSbcTab('overview');
}

const TESTING_FILES = {
  iso: 'project-rules-iso.json', edges: 'project-edges.json',
  cross: 'project-cross.json', scale: 'project-scale.json',
};

function toggleTestSelection(slug, checked) {
  if (checked) _testsSelected.add(slug); else _testsSelected.delete(slug);
  renderTestingTab();
}

// "Select all" — applies only to already-generated tests (a missing test
// cannot be "selected" for execution; only the "+ Generate this test"
// button on its own card applies in that case).
function toggleSelectAllTests(checked) {
  const sb = currentSandbox;
  if (!sb) return;
  const existingSlugs = Object.keys(TESTING_META).filter(s => (sb.testing || {})[s]);
  if (checked) existingSlugs.forEach(s => _testsSelected.add(s));
  else existingSlugs.forEach(s => _testsSelected.delete(s));
  renderTestingTab();
}

// Generates a missing test file — opens the sandbox-level ECA terminal
// with chorus-create-project --strategy <slug> in auto-execute mode.
// The sandbox/testing list will be refreshed manually (refreshSandboxQuiet
// or reload) once generation is complete on the agent side.
function generateTestingStrategy(slug) {
  if (!currentSandbox) return;
  openLevelTerminal('sandbox', { sbId: currentSandbox.id },
    `chorus-create-project ${currentSandbox.id} --strategy ${slug}`);
}

// Regenerates a SINGLE already-existing test file (⟲ icon next to an
// existing test's actions) — distinct from generateTestingStrategy (which
// targets a missing file, no backup needed). Backs up the existing file
// with a timestamped suffix first, same convention as generateAllTests(),
// to never silently overwrite a test that may have already been run/
// validated/analysed via chorus-strengthen.
function regenerateTestingStrategy(slug) {
  if (!currentSandbox) return;
  const sb = currentSandbox;
  const entry = (sb.testing || {})[slug];
  const file = entry ? entry.file : TESTING_FILES[slug];
  if (!confirm(`Régénérer « ${TESTING_META[slug]?.label || slug} » (${file}) ?\n\n` +
    `Le fichier existant sera d'abord sauvegardé avec un suffixe horodaté, ` +
    `puis régénéré depuis la KB (chorus-create-project --strategy ${slug}).`)) return;

  const cmd = `Avant toute chose, sauvegarde le fichier de test existant "${file}" dans ${sb.id} `
    + `en le copiant avec un suffixe horodaté (ex: ${file}.bak-AAAAMMJJ-HHMMSS) dans le même dossier. `
    + `Confirme le backup effectué, puis lance chorus-create-project ${sb.id} --strategy ${slug} `
    + `pour régénérer ce test.`;

  openLevelTerminal('sandbox', { sbId: sb.id }, cmd);
}

// Generates/re-generates ALL tests at once via chorus-create-project
// --batch (4 strategies: iso/edges/cross/scale). If test files already
// exist, the agent is explicitly asked to back them up (timestamped copy)
// before any replacement — never a silent overwrite of a test that may
// have already been run/validated. Left as natural language (rather than
// server-side scripted) so the agent confirms each backup before launching
// generation, cf. the convention used by other multi-step commands in
// this tab (runTestingSelection).
function generateAllTests() {
  if (!currentSandbox) return;
  const sb = currentSandbox;
  const testing = sb.testing || {};
  const existingFiles = Object.keys(TESTING_FILES)
    .filter(s => testing[s])
    .map(s => TESTING_FILES[s]);

  const cmd = existingFiles.length > 0
    ? `Avant toute chose, sauvegarde les fichiers de test existants suivants dans ${sb.id} `
      + `en les copiant avec un suffixe horodaté (ex: project-rules-iso.json.bak-AAAAMMJJ-HHMMSS) `
      + `dans le même dossier : ` + existingFiles.map(f => `"${f}"`).join(', ') + `. `
      + `Confirme chaque backup effectué, puis lance chorus-create-project ${sb.id} --batch `
      + `pour re-générer les 4 tests (iso/edges/cross/scale).`
    : `chorus-create-project ${sb.id} --batch`;

  openLevelTerminal('sandbox', { sbId: sb.id }, cmd);
}

// Runs a single existing test via chorus-check (never run.pl directly — cf.
// comment § TAB: TESTS at the top of the file).
function runTestingStrategy(slug) {
  if (!currentSandbox) return;
  const file = TESTING_FILES[slug];
  openLevelTerminal('sandbox', { sbId: currentSandbox.id },
    `chorus-check ${currentSandbox.id} ${file}`);
}

// Launches chorus-strengthen for a non-converged test — ALWAYS gated by an
// explicit confirmation modal first (never a direct onclick → fetch), given
// the known risk: this command can run for a long time, produce infinite
// loops on the Perl side, and spike CPU to 99% (cf. user warning). The
// terminal session is opened with kind:'strengthen' (see openLevelTerminal /
// levelTerminalExec § ctx.kind), which the server uses to (a) reject a 2nd
// concurrent strengthen on the same sandbox and (b) cap the timeout at 45min
// by default instead of 60 — see server/routes/terminal.js.
function confirmRunStrengthen(slug) {
  if (!currentSandbox) return;
  const sb      = currentSandbox;
  const meta    = TESTING_META[slug];
  const testing = sb.testing || {};

  // Reject immediately, client-side, if we already know (via the global
  // terminal badge / last poll of /api/terminals/active) that a strengthen
  // session is active on this sandbox — avoids a round-trip just to get
  // the same server-side refusal. Not a strict guarantee (race condition
  // possible if two tabs act at the same time) — the server-side check in
  // terminal.js is the actual authoritative guard.
  const already = (_activeTerminalsCache || [])
    .find(t => t.sbId === sb.id && t.kind === 'strengthen');
  if (already) {
    alert(
      `Un chorus-strengthen est déjà en cours sur ce sandbox ` +
      `(depuis ${Math.round((already.elapsedMs || 0) / 60000)} min).\n\n` +
      `Attendez sa fin avant d'en relancer un — l'exécution concurrente de ` +
      `plusieurs chorus-strengthen est fortement déconseillée (risque CPU élevé).`
    );
    return;
  }

  const ok = confirm(
    `Lancer chorus-strengthen sur le test « ${meta.label} » uniquement (${sb.id}) ?\n\n` +
    `⚠️ Cette opération peut être LONGUE (plusieurs dizaines de minutes), ` +
    `très consommatrice de CPU, et peut dans de rares cas entrer dans une ` +
    `boucle de diagnostic prolongée côté moteur Perl.\n\n` +
    `Un seul chorus-strengthen à la fois est autorisé par sandbox ` +
    `(verrou serveur) — le timeout est plafonné à 45 min pour cette opération.\n\n` +
    `Continuer ?`
  );
  if (!ok) return;

  // chorus-strengthen's documented trigger (`chorus-strengthen <sandbox>`)
  // always runs the FULL suite (all project-*.json) — there is no native
  // CLI scoping option (cf. Engine/agent/skills/chorus-strengthen.md § Phase
  // 0/1). The user explicitly asked to limit this button to the single
  // selected test, not the whole sandbox — so scope is restricted via an
  // explicit natural-language instruction rather than the bare trigger,
  // listing the other project files to leave untouched.
  const file = TESTING_FILES[slug];
  const otherFiles = Object.keys(TESTING_FILES)
    .filter(s => s !== slug && testing[s])
    .map(s => TESTING_FILES[s]);
  const scopeNote = otherFiles.length
    ? ` Limite-toi exclusivement au fichier "${file}" — ignore les autres fichiers de la suite `
      + `(${otherFiles.map(f => `"${f}"`).join(', ')}), même si chorus-strengthen analyse `
      + `normalement la suite complète par défaut.`
    : ` Limite-toi exclusivement au fichier "${file}".`;

  openLevelTerminal('sandbox', { sbId: sb.id, kind: 'strengthen' },
    `chorus-strengthen ${sb.id}` + scopeNote);
}

// Runs the current selection. If all present tests are selected
// → chorus-check --all (native batch mode, more efficient). Otherwise, a single
// natural-language command listing each chorus-check to run
// sequentially — left to the ECA agent rather than server-side scripted,
// precisely so that each file can trigger its own diagnostic/reinforcement
// loop if needed (cf. chorus-check.md).
function runTestingSelection() {
  if (!currentSandbox || _testsSelected.size === 0) return;
  const sb = currentSandbox;
  const testing = sb.testing || {};
  const existingSlugs = Object.keys(TESTING_META).filter(s => testing[s]);
  const selected = [..._testsSelected].filter(s => testing[s]);

  let cmd;
  if (selected.length === existingSlugs.length && existingSlugs.length > 1) {
    cmd = `chorus-check ${sb.id} --all`;
  } else if (selected.length === 1) {
    cmd = `chorus-check ${sb.id} ${TESTING_FILES[selected[0]]}`;
  } else {
    const files = selected.map(s => TESTING_FILES[s]);
    cmd = `Lance successivement chorus-check ${sb.id} sur chacun des fichiers suivants, dans cet ordre : `
      + files.map(f => `"${f}"`).join(', ')
      + `. Pour chaque fichier, exécute chorus-check ${sb.id} <fichier> (jamais run.pl directement) et résume le verdict avant de passer au suivant.`;
  }
  openLevelTerminal('sandbox', { sbId: sb.id }, cmd);
}

// ─── THESAURUS RENDERER ───────────────────────────────────────
let _thesData = [];
let _thesFilter = 'all';

function renderThesaurus(entries, filter) {
  _thesData = entries || [];
  _thesFilter = filter || 'all';

  const scopes = [...new Set(_thesData.map(e => e.scope))];
  const globalCount = _thesData.filter(e => e.scope === 'global').length;
  const entityCount = _thesData.filter(e => e.scope !== 'global').length;
  const typeCount   = _thesData.filter(e => e.kind === 'type').length;
  const slotCount   = _thesData.filter(e => e.kind === 'slot').length;

  const filtered = _thesData.filter(e => {
    if (_thesFilter === 'all')    return true;
    if (_thesFilter === 'global') return e.scope === 'global';
    if (_thesFilter === 'entity') return e.scope !== 'global';
    if (_thesFilter === 'type')   return e.kind === 'type';
    if (_thesFilter === 'slot')   return e.kind === 'slot';
    return true;
  });

  const shards = [...new Set(_thesData.map(e => e.shard))];

  const wrap = document.getElementById('corpus-thesaurus-wrap');
  wrap.innerHTML = `
    <div class="thes-summary">
      <div class="thes-summary-pill">
        <span class="pill-count">${_thesData.length}</span> total entries
      </div>
      <div class="thes-summary-pill">
        <span class="thes-scope global">global</span>
        <span class="pill-count">${globalCount}</span>
      </div>
      ${entityCount > 0 ? `<div class="thes-summary-pill">
        <span class="thes-scope entity">entity</span>
        <span class="pill-count">${entityCount}</span>
      </div>` : ''}
      <div class="thes-summary-pill">
        <span class="thes-kind">type</span>
        <span class="pill-count">${typeCount}</span>
      </div>
      <div class="thes-summary-pill">
        <span class="thes-kind">slot</span>
        <span class="pill-count">${slotCount}</span>
      </div>
      <div style="margin-left:auto;display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-muted)">
        Shards: ${shards.map(s => `<span class="thes-shard">${s}</span>`).join(' ')}
      </div>
    </div>
    <div class="thes-controls">
      <div class="thes-filter">
        ${['all','global','entity','type','slot'].map(f =>
          `<button onclick="renderThesaurus(null,'${f}')" class="${_thesFilter===f?'active':''}">${f}</button>`
        ).join('')}
      </div>
      <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${filtered.length} entries</span>
    </div>
    <table class="thes-table">
      <thead>
        <tr>
          <th>Surface term</th>
          <th></th>
          <th>KB slot</th>
          <th>Kind</th>
          <th>Scope</th>
          <th>Shard</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.length ? filtered.map(e => `
          <tr>
            <td class="thes-surface">${e.surface}</td>
            <td class="thes-arrow">→</td>
            <td class="thes-slot">${e.slot}</td>
            <td><span class="thes-kind">${e.kind}</span></td>
            <td><span class="thes-scope ${e.scope === 'global' ? 'global' : 'entity'}">${e.scope}</span></td>
            <td class="thes-shard">${e.shard}</td>
          </tr>
        `).join('') : `<tr><td colspan="6" style="color:var(--text-muted);padding:12px 10px;font-size:12px">No entries match this filter.</td></tr>`}
      </tbody>
    </table>
  `;
}

// ─── PIPELINE ────────────────────────────────────────────────
const PIPELINE_STEPS = [
  { id: 'load',    label: 'Load KB' },
  { id: 'resolve', label: 'Resolve corpus' },
  { id: 'infer',   label: 'Forward chain' },
  { id: 'check',   label: 'Check rules' },
  { id: 'verdict', label: 'Verdict' },
];

function selectProjectPipeline(projId) {
  if (!currentSandbox) return;
  const proj = (PROJECTS[currentSandbox.id] || []).find(p => p.id === projId);
  if (!proj) return;
  currentProject = proj;

  // Reset modal state
  document.getElementById('pipeline-proj-name').textContent = proj.name;
  document.getElementById('eca-wrap').style.display = 'none';
  document.getElementById('pipeline-verdict').style.display = 'none';
  document.getElementById('pipeline-steps').style.display = 'none';
  document.getElementById('pipeline-reports').style.display = 'none';
  document.getElementById('pipeline-log').innerHTML = '';
  const trigger = document.getElementById('eca-session-trigger');
  if (trigger) trigger.style.display = 'none';
  const ecaSess = document.getElementById('eca-session-wrap');
  if (ecaSess) ecaSess.style.display = 'none';
  const btn = document.getElementById('pipeline-run-btn');
  btn.disabled = false; btn.textContent = '▶ Lancer run.pl';
  pipelineRunning = false;
  resetEnginePanel();

  updateCmdPreview();
  document.getElementById('pipeline-modal-overlay').hidden = false;
}

function closePipelineModal() {
  if (pipelineRunning) {
    const ok = confirm(
      'Un run.pl est en cours d\'exécution.\n\n' +
      'Fermer ce panneau n\'interrompt PAS le traitement côté serveur — ' +
      'il continue en arrière-plan, mais vous ne pourrez plus suivre sa progression ' +
      'depuis cette fenêtre.\n\n' +
      'Fermer quand même ?'
    );
    if (!ok) return;
  }
  document.getElementById('pipeline-modal-overlay').hidden = true;
}


function projFilePath(proj, sbId) {
  // Convention réelle : workspace/<entity>/<projId>.json (flat)
  const entityId = proj.entity;
  return `workspace/${entityId}/${proj.id}.json`;
}

function updateCmdPreview() {
  if (!currentSandbox || !currentProject) return;
  const sbId     = currentSandbox.id;
  const projFile = projFilePath(currentProject, sbId);
  const perlEl = document.getElementById('cmd-perl-preview');
  if (perlEl) perlEl.textContent = `perl $SANDBOX/run.pl ${projFile}`;
}

function copyCmd(id) {
  const el = document.getElementById(id || 'cmd-perl-preview');
  if (el) navigator.clipboard.writeText(el.textContent).catch(() => {});
}

function renderPipelineSteps(activeId) {
  const done = [];
  let found = false;
  const html = PIPELINE_STEPS.map(s => {
    const isDone = !found && s.id !== activeId;
    const isActive = s.id === activeId;
    if (isActive) found = true;
    let cls = isDone ? 'done' : isActive ? 'active' : '';
    const icon = isDone ? '✓' : isActive ? '<span class="spinner"></span>' : '–';
    return `<div class="pipeline-step ${cls}">
      <span class="ps-num">${icon}</span>
      <span class="ps-label">${s.label}</span>
    </div>`;
  }).join('');
  document.getElementById('pipeline-steps').innerHTML = html;
}

// ─── INFERENCE ENGINE (pipeline panel) ───────────────────────
// Live-parses lines actually printed by run.pl
// (Chorus::Expert/Chorus::Engine) during SSE streaming — NO simulated data:
// each displayed field corresponds to a line actually produced by the Perl
// process for THIS specific run. If a line does not appear (a run.pl variant
// that does not print it), the corresponding panel element is simply hidden.
//
// Lignes reconnues (communes à tous les run.pl des sandboxes Chorus) :
//   "Feed: N element(s) loaded"                  → nombre d'éléments chargés
//   "  KB hash  : <sha256 ou n/a>"                → empreinte figée des règles YAML
//   "  Pipeline       : SOLVED ✅ | FAILED/TIMEOUT ❌"
//   "  %-16s  %7s  %6s  %6s  %5s" (tableau agent)  → ligne "Agent  Ciblés  OK  KO  NA"
let _enginePanelState = null;

function resetEnginePanel() {
  _enginePanelState = { feedCount: null, kbHash: null, agents: [] };
  const panel = document.getElementById('engine-panel');
  if (panel) panel.style.display = 'none';
  const agentsWrap = document.getElementById('engine-panel-agents');
  if (agentsWrap) agentsWrap.style.display = 'none';
}

function renderEnginePanel() {
  const st = _enginePanelState;
  if (!st) return;
  const panel = document.getElementById('engine-panel');
  if (!panel) return;

  const hasAnything = st.feedCount !== null || st.kbHash !== null || st.agents.length > 0;
  if (!hasAnything) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  const stats = [];
  if (st.feedCount !== null) {
    stats.push(`Feed : <span class="eng-stat-val">${st.feedCount}</span> élément${st.feedCount !== 1 ? 's' : ''} chargé${st.feedCount !== 1 ? 's' : ''} en Frames`);
  }
  if (st.kbHash !== null) {
    const short = st.kbHash.length > 16 ? st.kbHash.slice(0, 12) + '…' : st.kbHash;
    stats.push(`KB fingerprint : <span class="eng-stat-val" title="${st.kbHash}">${short}</span>`);
  }
  if (st.agents.length > 0) {
    stats.push(`Agents tracés : <span class="eng-stat-val">${st.agents.length}</span>`);
  }
  document.getElementById('engine-panel-stats').innerHTML = stats.join(' &nbsp;·&nbsp; ');

  const agentsWrap = document.getElementById('engine-panel-agents');
  if (st.agents.length > 0) {
    agentsWrap.style.display = 'block';
    document.getElementById('engine-agents-tbody').innerHTML = st.agents.map(a => `
      <tr>
        <td>${a.label}</td>
        <td>${a.targeted}</td>
        <td class="eng-ok">${a.ok !== '-' ? a.ok : '–'}</td>
        <td class="eng-ko">${a.ko !== '-' ? a.ko : '–'}</td>
        <td>${a.na !== '-' ? a.na : '–'}</td>
      </tr>`).join('');
  } else {
    agentsWrap.style.display = 'none';
  }
}

// Regex for the agent table row — handles the two formats actually
// printed by run.pl across the fleet (with or without NA column):
//   "  %-16s  %7d  %6s  %6s  %5s\n"  (CC/ETSI/ANSSI — avec NA)
//   "  %-16s  %7d  %6s  %6s\n"       (TimberFrame demo — sans NA)
const RE_AGENT_ROW = /^\s*([A-Za-zÀ-ÿ][\w À-ÿ]*?)\s{2,}(\d+)\s{2,}(-|\d+)\s{2,}(-|\d+)(?:\s{2,}(-|\d+))?\s*$/;

function parseEngineLogLine(line) {
  if (!_enginePanelState) return;
  let m;

  if ((m = line.match(/^Feed:\s*(\d+)\s+element/))) {
    _enginePanelState.feedCount = parseInt(m[1], 10);
    renderEnginePanel();
    return;
  }
  if ((m = line.match(/^\s*KB hash\s*:\s*(\S.*)$/))) {
    const val = m[1].trim();
    if (val && !val.startsWith('n/a')) _enginePanelState.kbHash = val;
    renderEnginePanel();
    return;
  }
  // Agent table row "Validation process — traversal by agent" — explicitly
  // ignores the header ('Agent  Targeted  OK  KO  NA') by requiring a
  // number in the 2nd capture group.
  if ((m = line.match(RE_AGENT_ROW)) && m[1].trim() !== 'Agent') {
    const [, label, targeted, ok, ko, na] = m;
    // Avoids duplicates if the same line is re-parsed (should not
    // happen with the SSE stream, but defensive)
    if (!_enginePanelState.agents.some(a => a.label === label.trim())) {
      _enginePanelState.agents.push({
        label: label.trim(),
        targeted: targeted.trim(),
        ok: (ok || '-').trim(),
        ko: (ko || '-').trim(),
        na: (na || '-').trim(),
      });
      renderEnginePanel();
    }
    return;
  }
}

function ecaTs() {
  return new Date().toTimeString().slice(0,8);
}

function addLog(msg, type = 'info') {
  const log = document.getElementById('pipeline-log');
  const line = document.createElement('div');
  line.className = 'eca-line';
  line.innerHTML = `<span class="eca-ts">${ecaTs()}</span><span class="eca-${type}">${msg}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function ecaShowCmd(cmd) {
  const log = document.getElementById('pipeline-log');
  const line = document.createElement('div');
  line.className = 'eca-line';
  line.innerHTML = `<span class="eca-prompt">chorus:~$</span><span class="eca-cmd"> ${cmd}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function ecaShowCursor() {
  const log = document.getElementById('pipeline-log');
  const line = document.createElement('div');
  line.className = 'eca-line';
  line.id = 'eca-cursor-line';
  line.innerHTML = `<span class="eca-prompt">chorus:~$</span><span class="eca-cursor"></span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function ecaRemoveCursor() {
  const cl = document.getElementById('eca-cursor-line');
  if (cl) cl.remove();
}

function runPipeline() {
  if (pipelineRunning) return;
  if (!currentProject) return;
  pipelineRunning = true;

  const btnId  = 'pipeline-run-btn';
  const btn    = document.getElementById(btnId);
  btn.disabled = true; btn.textContent = '⏳ En cours...';

  const proj      = currentProject;
  const sbId      = currentSandbox.id;
  const entityId  = proj.entity;
  const workspace = `sandboxes/${sbId}/workspace/${entityId}`;

  const log = document.getElementById('pipeline-log');
  log.innerHTML = '';
  resetEnginePanel();
  const ecaWrap = document.getElementById('eca-wrap');
  ecaWrap.style.display = 'block';
  document.getElementById('eca-title').textContent = `chorus — run.pl — ${sbId}/${entityId}`;
  document.getElementById('pipeline-verdict').style.display = 'none';
  document.getElementById('pipeline-reports').style.display = 'none';
  document.getElementById('pipeline-steps').style.display = 'flex';
  renderPipelineSteps(PIPELINE_STEPS[0].id);

  ecaShowCmd(`perl run.pl --sandbox ${sbId} --entity ${entityId} --project ${proj.id}`);
  ecaShowCursor();

  const url = `${API}/api/sandboxes/${sbId}/entities/${entityId}/projects/${proj.id}/run`;
  let first = true;

  function fail(message) {
    if (first) { ecaRemoveCursor(); first = false; }
    addLog(`❌ ${message}`, 'warn');
    pipelineRunning = false;
    btn.disabled = false; btn.textContent = '↺ Relancer run.pl';
    notifyBrowser('❌ Erreur pipeline', `${proj.name} · ${message}`);
  }

  fetch(url, { method: 'POST' }).then(async r => {
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const reader  = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const eMatch = part.match(/^event: (\w+)/m);
        const dMatch = part.match(/^data: (.+)/m);
        if (!eMatch || !dMatch) continue;
        const data = JSON.parse(dMatch[1]);
        if (eMatch[1] === 'log') {
          if (first) { ecaRemoveCursor(); first = false; }
          addLog(data.line, data.level === 'warn' ? 'warn' : 'info');
          parseEngineLogLine(data.line);
        } else if (eMatch[1] === 'done') {
          const exitLine = document.createElement('div');
          exitLine.className = 'eca-line eca-exit';
          exitLine.innerHTML = `<span class="eca-prompt">chorus:~$</span><span class="eca-dim"> [Process exited with code </span><span class="eca-ok">0</span><span class="eca-dim">]</span>`;
          log.appendChild(exitLine);
          log.scrollTop = log.scrollHeight;
          renderPipelineSteps(PIPELINE_STEPS[PIPELINE_STEPS.length - 1].id);
          finishPipeline(proj, workspace, btnId, data.reportData, data.reportFile);
        } else if (eMatch[1] === 'error') {
          fail(data.message);
        }
      }
    }
  }).catch(err => fail(err.message));
}

function finishPipeline(proj, workspace, btnId, reportData, reportFile) {
  try {
    _finishPipelineImpl(proj, workspace, btnId, reportData, reportFile);
  } catch (err) {
    console.error('finishPipeline failed — view will not be up to date without reload:', err);
  }
  // Systematic re-fetch from the server, in addition (not as a replacement)
  // to the in-memory patch done in _finishPipelineImpl above —
  // that patch can silently fail if `proj`/`currentProject` no longer exactly
  // matches the live object in PROJECTS[] (e.g. object rebuilt meanwhile
  // by a concurrent refresh), in which case the view would remain frozen
  // until a full F5 despite the report already written to disk (confirmed:
  // run-report-*.json present, but no in-memory structures updated).
  // This fallback is idempotent and cheap (a single GET /api/sandboxes/:sbId)
  // — it fixes the view even if the optimistic patch above could not be applied.
  if (currentSandbox?.id) refreshSandboxReports(currentSandbox.id);
}

function _finishPipelineImpl(proj, workspace, btnId, reportData, reportFile) {
  pipelineRunning = false;
  const btn = document.getElementById(btnId || 'pipeline-run-btn');
  btn.disabled = false;
  btn.textContent = '↺ Relancer run.pl';

  // All steps done
  document.getElementById('pipeline-steps').innerHTML = PIPELINE_STEPS.map(s =>
    `<div class="pipeline-step done"><span class="ps-num">✓</span><span class="ps-label">${s.label}</span></div>`
  ).join('');

  const verdictCode = reportData?.verdict || 'FAILED';
  const isSolved    = verdictCode === 'SOLVED';
  const total       = reportData?.totalFrames || proj.frames || 0;
  const conformes   = reportData?.conformes || 0;
  const nonConf     = reportData?.nonConformes || 0;
  const aConfirmer  = reportData?.aConfirmer || 0;
  const label       = reportFile || `compliance-report-${proj.id}.md`;

  notifyBrowser(
    isSolved ? '✅ Pipeline terminé — SOLVED' : '⚠️ Pipeline terminé — FAILED',
    `${proj.name} · ${conformes}/${total} CONFORMES`
  );

  // Verdict box + post-verdict chorus-check actions
  const verdict = document.getElementById('pipeline-verdict');
  verdict.style.display = 'block';
  verdict.innerHTML = `
    <div class="verdict-box ${isSolved ? 'solved' : 'failed'}">
      <div class="vb-icon">${isSolved ? '✅' : '⚠️'}</div>
      <div style="flex:1;min-width:0">
        <div class="vb-title">${verdictCode}</div>
        <div class="vb-detail">
${conformes} / ${total} exigences CONFORMES · ${nonConf} NON_CONFORME${aConfirmer ? ` · ${aConfirmer} à confirmer` : ''}<br>
Sandbox : ${currentSandbox.name} · Projet : ${proj.name}<br>
Run : ${new Date().toISOString().slice(0,19).replace('T',' ')} UTC
        </div>
      </div>
    </div>
`;

  // Rapport de conformité réel produit par run.pl
  const reportEntry = {
    icon: '📋',
    kind: 'run',
    label,
    desc: `${verdictCode} · ${conformes}/${total} CONFORMES`,
    path: `${workspace}/${proj.id}/${label}`,
    date: reportData?.date || new Date().toISOString().slice(0,10),
    run: 'run.pl',
    _reportData: reportData,
  };
  const liveProj = (PROJECTS[currentSandbox.id]||[]).find(p=>p.id===proj.id);
  if (liveProj) {
    if (!liveProj.reports) liveProj.reports = [];
    liveProj.reports.push(reportEntry);
    liveProj.verdict = verdictCode;
    if (total) liveProj.compliance = Math.round((conformes / total) * 100);
    liveProj.lastRun = reportEntry.date;
    if (total) liveProj.frames = total;
    // currentProject often points to the same object as liveProj, but this
    // is not guaranteed (e.g. object rebuilt elsewhere) — force sync so that
    // renderProjectPage() (called just after) reads the fresh values via
    // currentProject.
    if (currentProject && currentProject.id === liveProj.id) currentProject = liveProj;
  }

  // Refresh all PROJECTS-derived views — without this explicit refresh, the
  // sidebar/dashboard/projects tab and the project page itself would remain
  // frozen on the pre-run data until the next full page reload (F5), with
  // only initFromServer() re-querying them before this fix.
  renderSidebar();
  renderGlobalDashboard();
  if (document.getElementById('page-project')?.classList.contains('active') && currentProject) {
    const ents = (typeof ENTITIES !== 'undefined' ? ENTITIES[currentSandbox.id] : null) || [];
    const ent  = ents.find(e => e.id === currentProject.entity);
    renderProjectPage(currentProject, ent ? ent.label : (currentProject.entity || ''));
  } else {
    renderProjectsTab();
  }

  const wrap = document.getElementById('pipeline-reports');
  wrap.style.display = 'block';
  renderReportsList([reportEntry]);
}

function renderReportsList(reports) {
  // Sort by date desc (most recent first) — applied to the full list
  // (not only the runs displayed below) so that window._lastReports and
  // the indices used by openReportView()/openMdView() remain consistent
  // with the visual order.
  reports = sortReportsByDateDesc(reports);

  // Show only run-reports (.json) — explain/synthese reports are
  // represented by icons on each run row, linked by timestamp.
  const runReports = reports.filter(r => r.kind === 'run');
  const sbId     = currentSandbox?.id;
  const entityId = currentProject?.entity;
  const projId   = currentProject?.id;

  document.getElementById('reports-list').innerHTML = runReports.map((r) => {
    // Compliance score in bold and coloured
    const scoreMatch = r.desc.match(/(\d+)\/(\d+) CONFORMES/);
    const pct = scoreMatch
      ? Math.round(parseInt(scoreMatch[1]) / Math.max(parseInt(scoreMatch[2]), 1) * 100)
      : null;
    const pctColor = pct === null ? 'var(--text-muted)'
                   : pct >= 80   ? 'var(--ok)'
                   : pct >= 50   ? 'var(--warn,#f5a623)'
                   :               'var(--err)';
    const scoreHtml = scoreMatch
      ? `<strong style="color:${pctColor}">${pct}%</strong>&nbsp;<span style="color:var(--text-muted)">(${scoreMatch[1]}/${scoreMatch[2]})</span>`
      : '';
    const verdictStyle = r.desc.startsWith('SOLVED') ? 'color:var(--ok)' : 'color:var(--err)';

    // Index dans le tableau complet (pour openReportView)
    const fullIdx = reports.indexOf(r);

    // 📋 summary / 💡 explain icons — clickable if file present, greyed out otherwise
    const miniIcons = reportMiniIcons(r, sbId, entityId, projId);

    return `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-surface);border:1px solid var(--border);border-radius:6px">
      <span style="font-size:15px">📋</span>
      <div style="min-width:0;flex:1">
        <div class="mono" style="font-size:12px;color:var(--accent)">${r.label}</div>
        <div style="font-size:11px;margin-top:2px">
          <span style="${verdictStyle};font-weight:600">${r.desc.split('·')[0].trim()}</span>
          ${scoreHtml ? `&nbsp;·&nbsp;${scoreHtml}` : ''}
          ${r.date ? `&nbsp;·&nbsp;<span style="color:var(--text-muted)">${r.date}</span>` : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:2px">
        ${miniIcons}
        <button class="btn btn-ghost btn-sm" onclick="openReportView(_lastReports[${fullIdx}])">📊 View</button>
      </div>
    </div>`;
  }).join('');

  window._lastReports = reports;
}

/* ─── CHORUS-COMPLETE-REPORT ────────────────────────────── */

async function runCompleteReport(reportIndex, _directReport) {
  if (pipelineRunning) return;
  if (!currentProject || !currentSandbox) return;

  const report = _directReport || (window._lastReports || [])[reportIndex];
  if (!report) return;

  const proj   = currentProject;
  const sbId   = currentSandbox.id;
  const entityId  = proj.entity;
  const workspace = `sandboxes/${sbId}/workspace/${entityId}/reports/${proj.id}`;

  // Show ECA terminal
  document.getElementById('eca-wrap').style.display = 'block';
  const log = document.getElementById('pipeline-log');
  log.innerHTML = '';
  document.getElementById('eca-title').textContent = `chorus-complete-report — ${sbId}/${entityId} / ${proj.id}`;
  ecaShowCmd(`chorus-complete-report ${sbId} ${entityId} ${proj.id} --source ${report.label}`);
  ecaShowCursor();

  const url = `${API}/api/sandboxes/${sbId}/entities/${entityId}/projects/${proj.id}/check`
            + `?action=complete-report&input=${encodeURIComponent(report.label)}`;
  const es  = new EventSource(url);
  let first = true;
  let fullText = '';

  es.addEventListener('log', e => {
    if (first) { ecaRemoveCursor(); first = false; }
    const { line } = JSON.parse(e.data);
    addLog(line, 'info');
  });

  es.addEventListener('chunk', e => {
    const { text } = JSON.parse(e.data);
    fullText += text;
  });

  es.addEventListener('done', e => {
    const { filename } = JSON.parse(e.data);
    es.close();

    const exitLine = document.createElement('div');
    exitLine.className = 'eca-line eca-exit';
    exitLine.innerHTML = `<span class="eca-prompt">chorus:~$</span><span class="eca-dim"> [Process exited with code </span><span class="eca-ok">0</span><span class="eca-dim">]</span>`;
    log.appendChild(exitLine);
    log.scrollTop = log.scrollHeight;

    if (!filename) return;

    const newReport = {
      icon:  '📝',
      kind:  'complete-report',
      label: filename,
      desc:  `Rapport complet · issu de ${report.label}`,
      path:  `${workspace}/${filename}`,
      date:  new Date().toISOString().slice(0,10),
      run:   'chorus-complete-report',
      _sourceExplain: report.label,
      _text: fullText,
    };

    const allReports = [...(window._lastReports || [])];
    // Insert right after the source explain report
    const srcIdx = allReports.indexOf(report);
    if (srcIdx >= 0) allReports.splice(srcIdx + 1, 0, newReport);
    else allReports.push(newReport);
    renderReportsList(allReports);
  });

  es.addEventListener('error', e => {
    es.close();
    let message = 'connexion SSE perdue';
    try { message = JSON.parse(e.data).message; } catch {}
    addLog(`❌ ${message}`, 'warn');
  });
}

/* ─── REPORT VIEW MODAL ─────────────────────────────────── */

let _rvCurrentFilter = 'ALL';
let _rvCurrentReport = null;
let _mdvCtx = null;   // contexte du viewer Markdown (sbId, entityId, projId, filename)

// Element reason/motif — same fallback chain as run.pl (a single generic
// "motif" field, or one of its type_element-specific variants),
// plus English equivalents found on sandboxes with EN corpora
// (e.g. 02-building-en) where Helpers.pm writes "non_conformity_motif"/"reason"
// au lieu de "motif".
function elementMotif(e) {
  return e.motif ?? e.motif_impact ?? e.motif_generation ?? e.motif_affectation
    ?? e.motif_enrolement ?? e.motif_introduction ?? e.motif_utilisation
    ?? e.motif_fin_de_vie ?? e.motif_renouvellement ?? e.motif_recouvrement
    ?? e.archi_motif ?? e.motif_fourniture_code_source
    ?? e.non_conformity_motif ?? e.reason ?? e.non_conformity_reason ?? '—';
}

// Transforms the elements[] of the real run-report-*.json into displayable rows.
// Replaces the former generateMockRows() (100% fictional data, including the
// per-row "confidence" index — which has no equivalent in the real
// Chorus pipeline data).
function rowsFromRunReport(data) {
  return (data.elements || []).map(e => {
    // Verdicts bilingues : certains sandboxes (corpus EN, ex. UK Approved
    // Doc A) produisent des Frames avec verdict YES/NO/UNKNOWN au lieu de
    // CONFORME/NON_CONFORME/UNKNOWN (FR). Both forms must be recognised
    // so that the report-view does not group all English-language
    // elements under "to confirm" by default.
    // Integer verdicts: some multi-agent pipelines (run.pl T5) emit
    // verdict=1 (compliant) / verdict=0 (non-compliant) when verdict_of() returns
    // the value of an integer slot (component_operation_declared, dependency_catalog_ok…)
    // rather than a string (conformite_globale). Both forms must be recognised.
    const CONFORME_VALUES     = ['CONFORME', 'YES', 'SOLVED', 1, true];
    const NON_CONFORME_VALUES = ['NON_CONFORME', 'NO', 'FAILED', 0];
    const status = e.a_confirmer
      ? 'A_CONFIRMER'
      : CONFORME_VALUES.includes(e.verdict)
        ? 'CONFORME'
        : NON_CONFORME_VALUES.includes(e.verdict)
          ? 'NON_CONFORME'
          : 'A_CONFIRMER'; // unprocessed / unknown type / UNKNOWN — grouped with "to confirm"
    const chain = Array.isArray(e._rule_trace) && e._rule_trace.length
      ? e._rule_trace.map(t => t.rule_id).join(' → ')
      : '—';
    return {
      ref:          e.id || '?',
      label:        e.type_element || '?',
      status,
      rawVerdict:   e.verdict,
      motif:        elementMotif(e),
      source:       chain,
    };
  });
}

// Optional `ctx` { sbId, sbName, entityId, projId, projName } allows calling
// Ouvre le dernier rapport run du projet courant avec un filtre pré-activé.
// Appelé par les KPI cards "Non conformes" et "À confirmer" du projet.
function pvKpiOpenReport(filter) {
  if (!currentProject) return;
  const runReports = sortReportsByDateDesc(
    (currentProject.reports || []).filter(r => r.kind === 'run')
  );
  if (!runReports.length) return; // aucun run disponible — KPI card affiche "—"
  openReportView(runReports[0], undefined, filter);
}

// this viewer outside of the pipeline modal context (e.g. from the report
// history of a project that is not necessarily currentProject) —
// falls back to currentProject/currentSandbox otherwise.
async function openReportView(reportInfo, ctx, initialFilter = 'ALL') {
  const sbId      = ctx?.sbId      ?? currentSandbox?.id;
  const sbName    = ctx?.sbName    ?? currentSandbox?.name;
  const entityId  = ctx?.entityId  ?? currentProject?.entity;
  const projId    = ctx?.projId    ?? currentProject?.id;
  const projName  = ctx?.projName  ?? currentProject?.name;
  if (!sbId || !entityId || !projId) return;
  _rvCurrentReport = reportInfo;

  document.getElementById('rv-filename').textContent = reportInfo.label || `run-report-${projId}.json`;
  document.getElementById('rv-sandbox').textContent  = sbName || sbId;
  document.getElementById('rv-projet').textContent   = projName || projId;
  document.getElementById('rv-norme').textContent    = SANDBOXES.find(s => s.id === sbId)?.standard || '—';
  document.getElementById('rv-run').textContent      = reportInfo.run || 'run.pl';
  document.getElementById('rv-duration').textContent = '—'; // not tracked by run.pl — never fabricated

  // Store context so footer buttons (Summary/Explain) can use it
  window._rvCtx = { sbId, entityId, projId, projName: projName || projId };
  document.getElementById('report-view-overlay').hidden = false;
  const tbody = document.getElementById('rv-tbody');
  tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-muted)">Chargement du rapport réel…</td></tr>`;

  // Real data only: elements from run-report-*.json (verdict, motif,
  // rule chain) — no more simulated values (the per-row "confidence" index
  // of the old view did not exist in real data and was removed, replaced
  // by the actual motif).
  let data = null;
  try {
    const r = await fetch(`${API}/api/sandboxes/${sbId}/entities/${entityId}/projects/${projId}/run-report`);
    if (r.ok) ({ data } = await r.json());
  } catch { /* réseau indisponible — géré ci-dessous */ }

  if (!data) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-muted)">Aucun run-report trouvé pour ce projet — lancez <code class="mono">run.pl</code> d'abord.</td></tr>`;
    document.getElementById('rv-verdict-badge').textContent = '—';
    document.getElementById('rv-verdict-badge').className = 'rv-badge';
    document.getElementById('rv-frames').textContent = '—';
    document.getElementById('rv-date').textContent = '—';
    document.getElementById('rv-avg-conf').textContent = '—';
    updateRvFooter([]);
    return;
  }

  const isSolved = !!data.pipeline_solved;
  document.getElementById('rv-verdict-badge').textContent = isSolved ? 'SOLVED' : 'FAILED';
  document.getElementById('rv-verdict-badge').className = `rv-badge ${isSolved ? 'CONFORME' : 'NON_CONFORME'}`;
  document.getElementById('rv-frames').textContent = `${data.n_total ?? '—'} éléments`;
  document.getElementById('rv-date').textContent = (data.generated_at || '').replace('T', ' ').slice(0, 19) || '—';
  const tauxConf = data.n_total ? Math.round((data.n_conforme / data.n_total) * 100) : 0;
  document.getElementById('rv-avg-conf').textContent = `${tauxConf}%`;

  const rows = rowsFromRunReport(data);
  tbody.innerHTML = rows.map(r => `
    <tr data-status="${r.status}">
      <td><code class="mono" style="font-size:11px;color:var(--accent)">${r.ref}</code></td>
      <td style="color:var(--text-primary)">${r.label}${r.status==='A_CONFIRMER' && r.rawVerdict && r.rawVerdict!=='CONFORME' && r.rawVerdict!=='NON_CONFORME' ? ` <span style="color:var(--text-muted);font-size:10px">(${r.rawVerdict})</span>` : ''}</td>
      <td><span class="rv-badge ${r.status}">${r.status.replace('_',' ')}</span></td>
      <td style="font-size:11px;color:var(--text-secondary);max-width:280px">${r.motif}</td>
      <td><span style="font-size:10px;color:var(--text-muted);font-family:'JetBrains Mono',monospace">${r.source}</span></td>
    </tr>`
  ).join('') || `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-muted)">Aucun élément dans ce rapport.</td></tr>`;

  updateRvFooter(rows);
  filterReport('ALL');
  if (initialFilter !== 'ALL') filterReport(initialFilter);

  // Show "chorus-complete-report" button only for --explain reports —
  // et seulement si ce rapport n'a pas déjà été croisé (chorus-complete-report
  // Phase C4). Sans cette seconde vérification, le bouton "📝 Complete"
  // would remain displayed indefinitely even after a successful cross-check —
  // unlike the simple Markdown viewer (👁️, mdv-cross-area) which already detects
  // the enriched state via the same textual marker (see detectCompleteReportDone()).
  const completeBtn = document.getElementById('rv-complete-btn');
  if (completeBtn) {
    if (reportInfo && reportInfo.kind === 'explain' && reportInfo.label) {
      completeBtn.style.display = '';
      completeBtn.disabled   = false;
      completeBtn.title      = '';
      completeBtn.textContent = '📝 Complete';
      // Contenu texte non chargé par cette vue (seul le run-report JSON
      // structured content is, to populate the table above) — it is
      // fetched separately, best-effort: a network error simply leaves
      // the button active (previous behaviour, non-regressive).
      fetch(`${API}/api/sandboxes/${sbId}/entities/${entityId}/projects/${projId}/reports/${reportInfo.label}`)
        .then(r => r.ok ? r.text() : null)
        .then(text => {
          const status = detectCompleteReportDone(text);
          if (status && _rvCurrentReport === reportInfo) {
            completeBtn.disabled = true;
            if (status.kind === 'nothing') {
              // Zero-target guard — nothing to cross-check, re-running will
              // change nothing (cf. updateMdvCrossArea() for the same badge
              // in the simple Markdown viewer).
              completeBtn.title       = `chorus-complete-report exécuté le ${status.date} — rien à vérifier (aucun élément ❓ incertain)`;
              completeBtn.textContent = `✓ Complété (${status.date})`;
            } else {
              completeBtn.title       = `Déjà croisé avec la source le ${status.date}`;
              completeBtn.textContent = `✓ Complété (${status.date})`;
            }
          }
        })
        .catch(() => { /* best-effort — bouton reste actif en cas d'échec */ });
    } else {
      completeBtn.style.display = 'none';
    }
  }

  updateRvCheckButtons();
}

/**
 * Updates the Summary / Explain buttons in the report-view modal footer.
 * Always in "Generate" mode — old analyses from other runs must not
 * appear here; they are accessible via the history modal.
 * Exception: if the analysis was produced in the CURRENT session (it is
 * in _lastReports with kind summary/explain AND the current run-report is
 * also there), "View" can be offered — it is a fresh analysis of the same run.
 */
function updateRvCheckButtons() {
  const ctx      = window._rvCtx || {};
  const sbId     = ctx.sbId;
  const entityId = ctx.entityId;
  const projId   = ctx.projId;
  if (!sbId || !entityId || !projId) return;

  // Priority 1: fresh same-session analysis (in _lastReports alongside a run-report).
  // Priority 2: linked by timestamp — from explain_file/synthese_file on the run entry
  //             OR derived from the run label (handles minimal reportInfo from history modal).
  // If NONE found for either kind → single "Analyse" button (--from-report mode).
  // ⛔ No cross-slug fallback — only files explicitly linked to this run are valid.
  const sessionReports = window._lastReports || [];
  const hasCurrentRun  = sessionReports.some(r => r.kind === 'run');
  const proj           = (PROJECTS[sbId] || []).find(p => p.id === projId);

  // Resolve the best available report for each kind — strict slug match only
  const resolved = {};
  for (const kind of ['summary', 'explain']) {
    const fresh = hasCurrentRun ? sessionReports.find(r => r.kind === kind) : null;

    // Path A: explain_file/synthese_file already on the reportInfo (full entry)
    const directFile = kind === 'explain'
      ? (_rvCurrentReport?.explain_file  ?? null)
      : (_rvCurrentReport?.synthese_file ?? null);
    let linked = directFile ? { kind, label: directFile } : null;

    // Path B: reportInfo is minimal (only label — e.g. from history modal 👁️).
    // Derive the timestamp and look up the matching run entry in proj.reports,
    // which was populated by initFromServer() with the correct linked files.
    if (!linked && !fresh) {
      const ts = (_rvCurrentReport?.label || '').match(/run-report-(\d{8}-\d{6})\.json/)?.[1];
      if (ts) {
        const matchingRun = (proj?.reports || []).find(r => r.kind === 'run' && (r.label || '').includes(ts));
        const mFile = kind === 'explain' ? matchingRun?.explain_file : matchingRun?.synthese_file;
        if (mFile) linked = { kind, label: mFile };
      }
    }

    resolved[kind] = fresh || linked;  // null → Analyse button
  }

  // ── Case: neither summary nor explain exists → two separate "--from-report" buttons ──
  // ⛔ NE PAS combiner --summary --explain en une seule session : l'agent architect
  // (extended thinking) génère trop de contenu → timeout Java backend → "Error in
  // input stream". Un rapport par session = dans les limites de streaming.
  if (!resolved.summary && !resolved.explain) {
    // Hide the legacy combined "Analyse" button if it still exists in the DOM
    const analyseBtn = document.getElementById('rv-analyse-btn');
    if (analyseBtn) analyseBtn.style.display = 'none';

    // Show both individual buttons in "--from-report" generate mode
    for (const kind of ['summary', 'explain']) {
      const btn = document.getElementById(`rv-${kind}-btn`);
      if (!btn) continue;
      btn.style.display     = '';
      btn.innerHTML         = kind === 'summary' ? '📋 Summary' : '💡 Explain';
      btn.style.color       = '';
      btn.style.borderColor = '';
      btn.title             = `Générer --${kind} depuis ce run (sans relancer le pipeline)`;
      const k = kind;
      btn.onclick = () => openAnalyseFromReport(k);
    }
    return;
  }

  // ── Case: at least one exists → hide Analyse btn, show per-kind buttons ──
  const analyseBtn = document.getElementById('rv-analyse-btn');
  if (analyseBtn) analyseBtn.style.display = 'none';

  for (const kind of ['summary', 'explain']) {
    const btn = document.getElementById(`rv-${kind}-btn`);
    if (!btn) continue;
    btn.style.display = '';
    const existing = resolved[kind];
    const fresh    = hasCurrentRun ? sessionReports.find(r => r.kind === kind) : null;

    if (existing) {
      btn.innerHTML         = kind === 'summary' ? '📋 Summary' : '💡 Explain';
      btn.style.borderColor = fresh ? 'var(--success)' : '';
      btn.style.color       = fresh ? 'var(--success)' : '';
      btn.title             = existing.label;
      btn.onclick           = () => openMdView(sbId, entityId, projId, existing.label);
    } else {
      btn.innerHTML         = kind === 'summary' ? '📋 Summary' : '💡 Explain';
      btn.style.borderColor = '';
      btn.style.color       = '';
      btn.title             = `chorus-check --${kind} — générer une nouvelle analyse`;
      btn.onclick           = () => {
        closeReportView();
        if (!currentSandbox || currentSandbox.id !== sbId)
          currentSandbox = SANDBOXES.find(s => s.id === sbId) || { id: sbId, name: sbId };
        if (!currentProject || currentProject.id !== projId)
          currentProject = (PROJECTS[sbId] || []).find(p => p.id === projId)
            || { id: projId, entity: entityId, name: ctx.projName || projId };
        openChorusCheckTerminal(kind);
      };
    }
  }
}

/**
 * Opens a pre-contextualised ECA terminal to generate ONE report (--summary OR
 * --explain) from the current run-report WITHOUT relaunching the pipeline.
 *
 * ⛔ --summary et --explain ne sont JAMAIS combinés en une seule session :
 * l'agent architect (extended thinking) génère trop de contenu en un tour →
 * timeout Java backend → "Error in input stream". Chaque rapport = une session.
 *
 * @param {string} kind  'summary' | 'explain'
 */
function openAnalyseFromReport(kind = 'summary') {
  const ctx      = window._rvCtx || {};
  const sbId     = ctx.sbId;
  const entityId = ctx.entityId;
  const projId   = ctx.projId;
  const projName = ctx.projName;
  if (!sbId || !entityId || !projId) return;

  const runReportFile = _rvCurrentReport?.label;   // ex: "run-report-20261003-112847.json"
  if (!runReportFile) return;

  const runReportPath = `workspace/${entityId}/reports/${runReportFile}`;

  const cmd = `chorus-check ${sbId} --from-report ${runReportPath} --${kind}\n`
    + `Mode --from-report : charger les éléments directement depuis $SANDBOX/${runReportPath}.\n`
    + `⚠ NE PAS relancer run.pl, NE PAS appeler chorus_process ni le pipeline MCP.\n`
    + `Extraire RUN_TIMESTAMP du nom de fichier pour nommer les rapports produits.\n`
    + `Projet : ${projId}`;

  closeReportView();
  openLevelTerminal('project', { sbId, entityId, projId, projName: projName || projId }, cmd);
}

function closeReportView() {
  document.getElementById('report-view-overlay').hidden = true;
}

// ─── CONTEXTUALISED ECA TERMINAL — run report panel ──────────────────────────
// Opens an ECA terminal pre-contextualised with sandbox / entity / project /
// run-report slug + linked explain/synthese files if available.
function openRvTerminal() {
  const ctx = window._rvCtx || {};
  if (!ctx.sbId) return;

  // Resolve the explain/synthese files linked to THIS run (same logic as updateRvCheckButtons)
  const proj = (PROJECTS[ctx.sbId] || []).find(p => p.id === ctx.projId);
  const slug = (_rvCurrentReport?.label || '').match(/run-report-(\d{8}-\d{6})\.json/)?.[1];
  let explainFile  = _rvCurrentReport?.explain_file  ?? null;
  let syntheseFile = _rvCurrentReport?.synthese_file ?? null;
  if ((!explainFile || !syntheseFile) && slug && proj) {
    const matchRun = (proj.reports || []).find(r => r.kind === 'run' && (r.label || '').includes(slug));
    explainFile  = explainFile  || matchRun?.explain_file  || null;
    syntheseFile = syntheseFile || matchRun?.synthese_file || null;
  }

  openLevelTerminal('report', {
    sbId:        ctx.sbId,
    entityId:    ctx.entityId,
    projId:      ctx.projId,
    projName:    ctx.projName,
    reportFile:  _rvCurrentReport?.label || '',
    explainFile,
    syntheseFile,
  });
}

function runCompleteReportFromModal() {
  // Find index of current report in _lastReports to delegate to runCompleteReport(i)
  const reports = window._lastReports || [];
  const idx = reports.findIndex(r => r === _rvCurrentReport ||
    (r.kind === 'explain' && r.label === (_rvCurrentReport && _rvCurrentReport.label)));
  closeReportView();
  if (idx >= 0) {
    runCompleteReport(idx);
  } else {
    // Report may not be in list yet (e.g. opened from verdict) — run directly
    runCompleteReport(-1, _rvCurrentReport);
  }
}

function filterReport(status) {
  _rvCurrentFilter = status;
  // Update buttons
  const btnMap = { ALL:'rv-f-all', CONFORME:'rv-f-conforme', NON_CONFORME:'rv-f-nonconf', A_CONFIRMER:'rv-f-aconfirm' };
  Object.entries(btnMap).forEach(([s, id]) => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', s === status);
  });
  // Show/hide rows (data-status is the row's true compliance status, never mutated)
  const rows = document.querySelectorAll('#rv-tbody tr[data-status]');
  let visible = 0;
  rows.forEach(tr => {
    const rowStatus = tr.getAttribute('data-status');
    const show = status === 'ALL' || rowStatus === status;
    tr.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  document.getElementById('rv-count').textContent = `${visible} exigence${visible !== 1 ? 's' : ''} affichée${visible !== 1 ? 's' : ''}`;
}

function updateRvFooter(rows) {
  const conf   = rows.filter(r => r.status === 'CONFORME').length;
  const nonc   = rows.filter(r => r.status === 'NON_CONFORME').length;
  const pend   = rows.filter(r => r.status === 'A_CONFIRMER').length;
  document.getElementById('rv-footer-stats').textContent =
    `${conf} CONFORME · ${nonc} NON_CONFORME · ${pend} À confirmer · ${rows.length} total`;
}

async function runChorusCheckAction(action) {
  if (pipelineRunning) return;
  if (!currentProject || !currentSandbox) return;

  const proj      = currentProject;
  const sbId      = currentSandbox.id;
  const entityId  = proj.entity;
  const workspace = `sandboxes/${sbId}/workspace/${entityId}/reports/${proj.id}`;

  // Disable both action buttons while running
  const vaBtn = document.getElementById(`va-btn-${action}`);
  if (vaBtn) { vaBtn.disabled = true; vaBtn.style.opacity = '.5'; }

  pipelineRunning = true;
  const log = document.getElementById('pipeline-log');
  log.innerHTML = '';
  document.getElementById('eca-wrap').style.display = 'block';
  document.getElementById('eca-title').textContent = `chorus-check --${action} — ${sbId}/${entityId}`;

  ecaShowCmd(`chorus-check ${sbId} ${entityId} ${proj.id} --${action}`);
  ecaShowCursor();

  const url = `${API}/api/sandboxes/${sbId}/entities/${entityId}/projects/${proj.id}/check?action=${action}`;
  const es  = new EventSource(url);
  let first = true;
  let fullText = '';

  function done() {
    es.close();
    pipelineRunning = false;
    if (vaBtn) { vaBtn.disabled = false; vaBtn.style.opacity = '1'; }
  }

  es.addEventListener('log', e => {
    if (first) { ecaRemoveCursor(); first = false; }
    const { line } = JSON.parse(e.data);
    addLog(line, 'info');
  });

  es.addEventListener('chunk', e => {
    const { text } = JSON.parse(e.data);
    fullText += text;
  });

  es.addEventListener('done', e => {
    const { filename } = JSON.parse(e.data);
    done();

    const exitLine = document.createElement('div');
    exitLine.className = 'eca-line eca-exit';
    exitLine.innerHTML = `<span class="eca-prompt">chorus:~$</span><span class="eca-dim"> [Process exited with code </span><span class="eca-ok">0</span><span class="eca-dim">]</span>`;
    log.appendChild(exitLine);
    log.scrollTop = log.scrollHeight;

    if (vaBtn) {
      vaBtn.style.borderColor = 'var(--success)';
      vaBtn.style.position = 'relative';
      const doneTag = document.createElement('span');
      doneTag.style.cssText = 'position:absolute;top:6px;right:8px;font-size:10px;color:var(--success)';
      doneTag.textContent = '✓ généré';
      vaBtn.appendChild(doneTag);
    }

    const reportEntry = {
      icon: action === 'summary' ? '📋' : '💡',
      kind: action,
      label: filename,
      desc: action === 'summary'
        ? 'Synthèse 1 page — chiffres clés, recommandation (chorus-check --summary)'
        : 'Explications règle par règle — NON_CONFORME (chorus-check --explain)',
      path: `${workspace}/${filename}`,
      date: new Date().toISOString().slice(0,10),
      run: `chorus-check --${action}`,
      _text: fullText,
    };

    // Push to proj.reports[]
    const checkProj = (PROJECTS[sbId]||[]).find(p=>p.id===proj.id);
    if (checkProj) {
      if (!checkProj.reports) checkProj.reports = [];
      checkProj.reports.push(reportEntry);
    }

    const existingReports = window._lastReports ? [...window._lastReports] : [];
    existingReports.push(reportEntry);
    renderReportsList(existingReports);

    // Refresh PROJECTS-derived views — same reason as in
    // finishPipeline(): without this explicit call, the sidebar/dashboard/
    // projects tab would remain frozen on the pre-summary/--explain state
    // until the next F5 (initFromServer()).
    renderSidebar();
    renderGlobalDashboard();
    if (document.getElementById('page-project')?.classList.contains('active') && currentProject) {
      const ents = (typeof ENTITIES !== 'undefined' ? ENTITIES[sbId] : null) || [];
      const ent  = ents.find(e => e.id === currentProject.entity);
      renderProjectPage(currentProject, ent ? ent.label : (currentProject.entity || ''));
    } else {
      renderProjectsTab();
    }

    // Show ECA session trigger after --summary or --explain
    const trigger = document.getElementById('eca-session-trigger');
    if (trigger) trigger.style.display = 'block';
  });

  es.addEventListener('error', e => {
    done();
    let message = 'connexion SSE perdue';
    try { message = JSON.parse(e.data).message; } catch {}
    addLog(`❌ ${message}`, 'warn');
  });
}

// ─── ECA SESSION TRIGGER (pipeline modal, post --summary/--explain) ───
// Delegates to the generic multi-level terminal (openLevelTerminal) so that
// the experience is identical to the 🖥️ sandbox/entity/project/report buttons.
function openEcaSessionForProject() {
  if (!currentProject || !currentSandbox) return;
  openLevelTerminal('project', {
    sbId:     currentSandbox.id,
    entityId: currentProject.entity,
    projId:   currentProject.id,
    projName: currentProject.name,
  });
}

// ─── GENERIC ECA TERMINAL — levels sandbox / entity / project / report ──────
//
// A single interactive terminal, reusable at every navigation level.
// The loaded context (and therefore the responses) varies by level:
//   sandbox  → sandbox overview (entities, projects, standard)
//   entity   → entity projects, path workspace/<entity>/
//   project  → frames + latest project reports (sources/ + reports/)
//   report   → content of the specific selected report
let _lvlTermCtx = null;
let _lvlTermHistory = [];
let _lvlTermStartTs = 0;   // timestamp de début de la requête courante
let _lvlTermHistIdx = -1;
let _lvlTermSessionId = null;
let _lvlTermAbortCtrl = null;  // AbortController de la requête SSE courante
let _lvlTermLastCmd   = null;  // dernière commande exécutée (pour Retry)
let _lvlTermMinimized = false; // true si le terminal est réduit (overlay masqué, stream/session toujours vivants)
// Regroupement visuel des sous-agents parallèles (Engine/TODO.org [#J]
// Axe 5, étape 3) — subagentChatId → élément DOM de la section pliable
// correspondante, pour router chaque 'subagent-tool' reçu vers la bonne
// section (plutôt que de les mélanger dans le flux linéaire principal).
// Réinitialisé à chaque ouverture de terminal (openLevelTerminal).
let _lvlTermSubagentSections = new Map();

function levelPromptLabel(ctx) {
  const { level, sbId, entityId, projId, reportFile } = ctx;
  if (level === 'sandbox') return `${sbId} ?>`;
  if (level === 'entity')  return `${sbId}/${entityId} ?>`;
  if (level === 'project') return `${sbId}/${entityId}/${projId} ?>`;
  if (level === 'report')  return `${sbId}/${entityId}/${projId}/${reportFile} ?>`;
  return 'chorus ?>';
}

// ── Lightweight terminal history persistence ────────────────────────────
// Key indexed on the CONTEXT (sandbox/entity/project/report), not on
// _lvlTermSessionId which is regenerated at every opening — this is exactly
// what allows history to be recovered after an accidental close or page refresh.
// ONLY the frozen history of completed exchanges (event:done) is persisted:
// never during active streaming, to avoid any attempt (out of scope here) to
// "resume" an SSE stream already closed server-side on tab close.
const LVL_TERM_HIST_PREFIX  = 'eca-term-hist:';
const LVL_TERM_HIST_MAXCHAR = 60_000; // ~60 Ko bruts conservés par contexte
const LVL_TERM_HIST_TTL_MS  = 7 * 24 * 3600 * 1000; // purge après 7 jours d'inactivité

function lvlTermHistKey(ctx) {
  if (!ctx) return null;
  return LVL_TERM_HIST_PREFIX +
    [ctx.sbId, ctx.level, ctx.entityId || '', ctx.projId || '', ctx.reportFile || ''].join(':');
}

/** Saves the current terminal output state (frozen HTML, excluding the
 * cursor/in-progress input lines) under the context key. Truncates if needed
 * by keeping only the end (the most recent exchanges). */
function lvlTermSaveHistory() {
  const key = lvlTermHistKey(_lvlTermCtx);
  const out = document.getElementById('lvl-term-output');
  if (!key || !out) return;
  let html = out.innerHTML;
  if (html.length > LVL_TERM_HIST_MAXCHAR) {
    html = html.slice(html.length - LVL_TERM_HIST_MAXCHAR);
  }
  try {
    localStorage.setItem(key, JSON.stringify({ html, savedAt: Date.now() }));
  } catch { /* quota localStorage dépassé — best-effort, pas bloquant */ }
}

/** Restores (if present and not expired) the previous history for this
 * context, inserted just after the welcome message. Returns true if
 * restoration took place (to visually inform the user). */
function lvlTermRestoreHistory(ctx) {
  const key = lvlTermHistKey(ctx);
  if (!key) return false;
  let raw;
  try { raw = localStorage.getItem(key); } catch { return false; }
  if (!raw) return false;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { localStorage.removeItem(key); return false; }
  if (!parsed || !parsed.html || (Date.now() - (parsed.savedAt || 0)) > LVL_TERM_HIST_TTL_MS) {
    localStorage.removeItem(key);
    return false;
  }
  const out = document.getElementById('lvl-term-output');
  if (!out) return false;
  const sep = document.createElement('div');
  sep.className = 'lvl-term-restore-sep';
  sep.textContent = `━━━ Historique restauré (dernière activité ${new Date(parsed.savedAt).toLocaleString('fr-FR')}) ━━━`;
  out.appendChild(sep);
  const wrap = document.createElement('div');
  wrap.innerHTML = parsed.html;
  out.appendChild(wrap);
  out.scrollTop = out.scrollHeight;
  return true;
}

/** Purges the persisted history for a given context (called on
 * explicit terminal close by the user). */
function lvlTermClearHistory(ctx) {
  const key = lvlTermHistKey(ctx);
  if (key) { try { localStorage.removeItem(key); } catch {} }
}

/** Handler du bouton 🗑 — efface l'historique persisté ET l'affichage
 * courant du contexte actif, après confirmation (action non réversible). */
function lvlTermClearHistoryConfirm() {
  if (!_lvlTermCtx) return;
  if (!confirm('Effacer définitivement l\'historique sauvegardé de ce terminal ?')) return;
  lvlTermClearHistory(_lvlTermCtx);
  const out = document.getElementById('lvl-term-output');
  document.querySelectorAll('.lvl-term-restore-sep').forEach(el => {
    // Removes the restore separator and everything it introduced
    let next = el.nextElementSibling;
    el.remove();
    if (next) next.remove();
  });
}

function lvlTermSameCtx(a, b) {
  if (!a || !b) return false;
  return a.level === b.level && a.sbId === b.sbId && (a.entityId||null) === (b.entityId||null)
    && (a.projId||null) === (b.projId||null) && (a.reportFile||null) === (b.reportFile||null);
}

function openLevelTerminal(level, ctx, autoCmd = null) {
  const requestedCtx = { level, ...ctx };

  // Re-opening a minimised terminal on EXACTLY the same context: do not
  // reinitialise anything (session/stream in progress, output already shown) —
  // simply show the overlay again as-is, restored identically.
  if (_lvlTermMinimized && lvlTermSameCtx(_lvlTermCtx, requestedCtx)) {
    hideMinimizedTerminalIndicator();
    _lvlTermMinimized = false;
    document.getElementById('level-terminal-overlay').hidden = false;
    const out = document.getElementById('lvl-term-output');
    if (out) out.scrollTop = out.scrollHeight;
    const input = document.getElementById('lvl-term-input');
    if (input && !input.disabled) input.focus();
    return;
  }

  // Another minimised terminal was active: close it cleanly (stop +
  // ECA chat deletion) before opening a new one — never more than one
  // terminal/session alive in the background at a time.
  if (_lvlTermMinimized) {
    hideMinimizedTerminalIndicator();
    levelTerminalStop();
    if (_lvlTermCtx && _lvlTermCtx.sbId && _lvlTermSessionId) {
      fetch(`${API}/api/sandboxes/${_lvlTermCtx.sbId}/terminal`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: _lvlTermSessionId }),
      }).catch(() => {});
    }
    _lvlTermMinimized = false;
  }

  _lvlTermCtx = requestedCtx;
  _lvlTermHistory = [];
  _lvlTermHistIdx = -1;
  // A single ECA chat per terminal opening — preserves history between
  // turns (cf. server.js § ROUTE 5bis /terminal, chatId = `term-${sessionId}`).
  _lvlTermSessionId = 'lvlterm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  _lvlTermSubagentSections = new Map();

  const overlay = document.getElementById('level-terminal-overlay');
  const out     = document.getElementById('lvl-term-output');
  const badge   = document.getElementById('lvl-term-badge');

  badge.textContent = level;
  document.getElementById('lvl-term-title').textContent =
    `ECA — ${levelPromptLabel(_lvlTermCtx).replace(' ?>','')} — session interactive`;
  document.getElementById('lvl-term-prompt').textContent = levelPromptLabel(_lvlTermCtx);
  // Nouvelle session = pas encore de skill chargé — masquer le bandeau
  // persisté d'une éventuelle session précédente (Engine/TODO.org [#J] Axe 3).
  const skillBanner = document.getElementById('lvl-term-skill-banner');
  if (skillBanner) skillBanner.hidden = true;
  // Idem pour le panneau de tâches (Engine/TODO.org [#J] Axe 4).
  const taskboardPanel = document.getElementById('lvl-term-taskboard');
  if (taskboardPanel) taskboardPanel.hidden = true;

  out.innerHTML = '';
  overlay.hidden = false;

  const welcome = [];
  if (level === 'sandbox') {
    const sb = SANDBOXES.find(s => s.id === ctx.sbId);
    const entities = ENTITIES[ctx.sbId] || [];
    welcome.push(
      { cls:'dim',  text: `━━━ ECA session — sandbox ${ctx.sbId} ━━━` },
      { cls:'info', text: `[ECA] Contexte chargé : ${sb ? sb.standard : '?'} · ${entities.length} entity(ies)` },
      { cls:'dim',  text: `Exemples : "liste les entities" · "chorus-check --all" · "résumé du sandbox"` },
    );
  } else if (level === 'entity') {
    const projs = (PROJECTS[ctx.sbId] || []).filter(p => p.entity === ctx.entityId);
    welcome.push(
      { cls:'dim',  text: `━━━ ECA session — entity ${ctx.entityId} (${ctx.sbId}) ━━━` },
      { cls:'info', text: `[ECA] Contexte chargé : workspace/${ctx.entityId}/ · ${projs.length} projet(s)` },
      { cls:'dim',  text: `Exemples : "liste les projets" · "quel est le taux de conformité moyen ?"` },
    );
  } else if (level === 'project') {
    const proj = (PROJECTS[ctx.sbId] || []).find(p => p.id === ctx.projId);
    welcome.push(
      { cls:'dim',  text: `━━━ ECA session — ${ctx.sbId}/${ctx.entityId}/${ctx.projId} ━━━` },
      { cls:'info', text: `[ECA] Contexte chargé : workspace/${ctx.entityId}/${ctx.projId}.json · ${proj ? proj.frames : 0} frames · workspace/${ctx.entityId}/reports/` },
      { cls:'dim',  text: `Exemples : "liste les NON_CONFORMES" · "chorus-check --explain" · "Pourquoi R07 ?"` },
    );
  } else if (level === 'report') {
    const proj = (PROJECTS[ctx.sbId] || []).find(p => p.id === ctx.projId);
    const slug = (ctx.reportFile || '').match(/run-report-(\d{8}-\d{6})\.json/)?.[1] || '?';
    const hasSynthese = !!ctx.syntheseFile;
    const hasExplain  = !!ctx.explainFile;
    welcome.push(
      { cls:'dim',  text: `━━━ ECA session — run-report ${slug} ━━━` },
      { cls:'info', text: `[ECA] Sandbox  : ${ctx.sbId}` },
      { cls:'info', text: `[ECA] Entity   : workspace/${ctx.entityId}/` },
      { cls:'info', text: `[ECA] Projet   : ${ctx.projId}.json  (${proj ? proj.frames : '?'} éléments)` },
      { cls:'info', text: `[ECA] Run      : workspace/${ctx.entityId}/reports/${ctx.reportFile}` },
      { cls: hasSynthese ? 'ok'  : 'warn', text: `[ECA] Synthèse : ${hasSynthese ? ctx.syntheseFile : '⚠ absent — lancer chorus-check --summary'}` },
      { cls: hasExplain  ? 'ok'  : 'warn', text: `[ECA] Explain  : ${hasExplain  ? ctx.explainFile  : '⚠ absent — lancer chorus-check --explain'}` },
      { cls:'dim',  text: `Exemples : "chorus-complete-report ${ctx.sbId} ${ctx.entityId} --slug ${slug}" · "explique les NON_CONFORMES" · "quels artefacts pipeline ?"` },
    );
  }

  let t = 0;
  welcome.forEach(({ cls, text }) => {
    setTimeout(() => lvlTermAppend(text, cls), t);
    t += 180;
  });
  setTimeout(() => {
    // Historique NON restauré automatiquement à l'ouverture : chaque
    // ouverture de terminal doit démarrer sur une session propre, sans
    // texte/buffer de l'ancienne session pour ce contexte (cf. demande
    // utilisateur — la restauration silencieuse de localStorage faisait
    // réapparaître l'historique de la session précédente). La fonction
    // lvlTermRestoreHistory() et le mécanisme de persistance restent en
    // place (bouton 🗑 lvlTermClearHistoryConfirm, lvlTermSaveHistory)
    // pour une réactivation future explicite si besoin, mais ne sont
    // plus invoqués automatiquement ici.
    const input = document.getElementById('lvl-term-input');
    if (input) input.focus();
    // Auto-execute command if provided (chorus-check --summary/--explain)
    if (autoCmd) {
      setTimeout(() => {
        if (input) { input.value = autoCmd; }
        levelTerminalExec(autoCmd);
        if (input) { input.value = ''; }
      }, 400);
    }
  }, t + 100);
}

// ─── CHORUS-CHECK TERMINAL ────────────────────────────────────
// Opens the ECA terminal at 'project' level and automatically runs
// chorus-check --summary or --explain on the existing compliance report.
// The ECA skill receives the report path — it does not relaunch run.pl.
function openChorusCheckTerminal(action) {
  if (!currentProject || !currentSandbox) return;
  const proj     = currentProject;
  const sbId     = currentSandbox.id;
  const entityId = proj.entity;

  // Find the existing compliance report (produced by run.pl)
  const reports   = window._lastReports || [];
  const runReport = reports.find(r => r.kind === 'run' || (r.run || '').startsWith('run.pl'));
  const reportFile = runReport ? runReport.label : null;

  // Command sent to ECA: explicitly indicate the existing report
  // so that chorus-check does not relaunch run.pl
  const cmd = reportFile
    ? `chorus-check ${sbId} ${proj.id} --${action}\n`
      + `⚠ Le rapport de conformité a déjà été généré : workspace/${entityId}/reports/${reportFile}\n`
      + `Utilise ce rapport existant — ne relance pas run.pl.`
    : `chorus-check ${sbId} ${proj.id} --${action}`;

  openLevelTerminal('project', {
    sbId,
    entityId,
    projId:   proj.id,
    projName: proj.name,
  }, cmd);
}

function closeLevelTerminal() {
  if (_lvlTermAbortCtrl) {
    const ok = confirm(
      'Une session ECA est en cours dans ce terminal.\n\n' +
      'Fermer ce panneau (✕) interrompt la génération en cours et clôt ' +
      'définitivement cette session ECA (son historique de conversation ' +
      'sera perdu). Pour laisser le traitement continuer en arrière-plan ' +
      'et le retrouver tel quel plus tard, utilisez plutôt « ➖ Réduire ».\n\n' +
      'Fermer définitivement quand même ?'
    );
    if (!ok) return;
    // Interrupt the ongoing stream before deleting the chat, otherwise the
    // generation would keep writing to a chat that has just been deleted
    // server-side (same sequence as levelTerminalStop()).
    levelTerminalStop();
  }
  // Definitively close the ECA chat for this session — without this call,
  // the chat would remain open indefinitely on the eca-server (observed in
  // practice: chats in "idle"/"running" status never cleaned up), despite the
  // panel being closed on the UI side. Best-effort: panel close is never
  // blocked by this call (fire-and-forget).
  if (_lvlTermCtx && _lvlTermCtx.sbId && _lvlTermSessionId) {
    fetch(`${API}/api/sandboxes/${_lvlTermCtx.sbId}/terminal`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: _lvlTermSessionId }),
    }).catch(() => {});
  }
  document.getElementById('level-terminal-overlay').hidden = true;
  _lvlTermCtx = null;
  _lvlTermSessionId = null;
  _lvlTermMinimized = false;
  hideMinimizedTerminalIndicator();
}

/** Minimises the terminal without interrupting anything: simply hides the
 * overlay; the ongoing SSE fetch (if any) continues receiving chunks and
 * feeding the background history (the browser keeps the HTTP stream open
 * as long as the tab is loaded — unlike a close which cancels the stream
 * and deletes the ECA chat server-side). Displays a floating indicator
 * allowing the terminal to be reopened identically via
 * openLevelTerminal() on the same context (cf. lvlTermSameCtx). */
function minimizeLevelTerminal() {
  if (!_lvlTermCtx) return;
  _lvlTermMinimized = true;
  document.getElementById('level-terminal-overlay').hidden = true;
  showMinimizedTerminalIndicator();
}

function showMinimizedTerminalIndicator() {
  let el = document.getElementById('lvl-term-minimized-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lvl-term-minimized-indicator';
    el.style.cssText =
      'position:fixed;bottom:18px;right:18px;z-index:850;display:flex;align-items:center;gap:8px;' +
      'background:var(--bg-surface,#161B22);border:1px solid var(--accent,#3B82F6);border-radius:24px;' +
      'padding:8px 14px 8px 12px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4);' +
      'font-family:\'JetBrains Mono\',monospace;font-size:12px;color:var(--text-primary,#E6EDF3)';
    el.onclick = () => {
      if (_lvlTermCtx) openLevelTerminal(_lvlTermCtx.level, _lvlTermCtx);
    };
    document.body.appendChild(el);
  }
  const label = _lvlTermCtx ? levelPromptLabel(_lvlTermCtx).replace(' ?>', '') : '?';
  const busy = !!_lvlTermAbortCtrl;
  el.innerHTML =
    `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${busy ? '#F5A623' : '#10B981'};${busy ? 'animation:lvlTermPulse 1.2s infinite' : ''}"></span>` +
    `<span>🖥️ ECA — ${escapeHtml(label)}</span>` +
    `<span style="color:var(--text-muted,#8B949E)">${busy ? '· en cours…' : '· réduit'}</span>`;
  el.hidden = false;
}

function hideMinimizedTerminalIndicator() {
  const el = document.getElementById('lvl-term-minimized-indicator');
  if (el) el.hidden = true;
}

function levelTerminalStop() {
  // 1. Annuler le fetch SSE côté navigateur
  if (_lvlTermAbortCtrl) { _lvlTermAbortCtrl.abort(); _lvlTermAbortCtrl = null; }
  // 2. Signal the server to stop the ECA subReq — sessionId required for
  // the server to find the correct activeTerminals entry (indexed by
  // session, not by sandbox, since the ECA chat isolation fix —
  // see server.js § ROUTE 5bis/5quater).
  if (_lvlTermCtx && _lvlTermCtx.sbId && _lvlTermSessionId) {
    fetch(`${API}/api/sandboxes/${_lvlTermCtx.sbId}/terminal/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: _lvlTermSessionId }),
    }).catch(() => {});
  }
}

// ─── DOM RING BUFFER — cap on the number of live displayed nodes ──────────
// A heavy session (chorus-feed, chorus-create-project --batch…) can produce
// hundreds of tool-calls. Without a limit, the DOM of #lvl-term-output would
// grow indefinitely during the active session (distinct from the persisted
// history cap LVL_TERM_HIST_MAXCHAR, which only applies to localStorage
// saving once the exchange is frozen). The oldest DOM nodes beyond
// LVL_TERM_MAX_LINES are therefore pruned — the ECA agent and the sandbox
// are never affected, only the live display is trimmed.
const LVL_TERM_MAX_LINES = 2000;

function lvlTermPruneOldLines() {
  const out = document.getElementById('lvl-term-output');
  if (!out) return;
  const excess = out.children.length - LVL_TERM_MAX_LINES;
  if (excess <= 0) return;
  // Insère (une seule fois, de façon idempotente) un marqueur juste avant
  // la coupe pour signaler visuellement la troncature, puis retire les
  // nœuds les plus anciens en tête du buffer.
  let marker = out.querySelector('.eca-term-pruned-marker');
  if (!marker) {
    marker = document.createElement('div');
    marker.className = 'eca-session-line dim eca-term-pruned-marker';
    marker.textContent = `… lignes plus anciennes retirées de l'affichage (limite ${LVL_TERM_MAX_LINES} lignes — l'historique complet reste disponible côté sandbox) …`;
    out.insertBefore(marker, out.firstChild);
  }
  // Removes from the beginning, skipping the marker itself.
  let removed = 0;
  let node = out.firstChild;
  while (node && removed < excess) {
    const next = node.nextSibling;
    if (node !== marker) { out.removeChild(node); removed++; }
    node = next;
  }
}

function lvlTermAppend(text, cls = 'resp') {
  const out  = document.getElementById('lvl-term-output');
  const line = document.createElement('div');
  line.className = `eca-session-line ${cls}`;
  line.textContent = text;
  out.appendChild(line);
  lvlTermPruneOldLines();
  out.scrollTop = out.scrollHeight;
  return line;
}

// Border colour by tool family — consistent with the terminal panel legend
// (read = neutral, edit = accent, shell = warn,
// git = info, agent = purple to clearly distinguish a spawned sub-agent).
const TOOL_FAMILY_COLOR = {
  read:  '#4E6A8A',
  edit:  '#58A6FF',
  shell: '#D29922',
  git:   '#3FB950',
  agent: '#B388FF',
  task:  '#8B949E',
  skill: '#4E9BF5',
  other: '#6E7B8A',
};

/**
 * Met à jour le bandeau "Skill actif" du panneau terminal (Engine/TODO.org
 * [#J] Axe 3) à partir d'un événement SSE 'skill' ({ name, history }).
 * Persiste à l'écran même après défilement du log principal — bandeau fixe
 * sous la titlebar, voir chorus-web.html § #lvl-term-skill-banner.
 */
function lvlTermUpdateSkillBanner({ name, history }) {
  const banner = document.getElementById('lvl-term-skill-banner');
  const nameEl = document.getElementById('lvl-term-skill-name');
  const histEl = document.getElementById('lvl-term-skill-history');
  if (!banner || !nameEl) return;
  banner.hidden = false;
  nameEl.textContent = name || '?';
  if (histEl) {
    const prior = Array.isArray(history) ? history.slice(0, -1) : [];
    histEl.textContent = prior.length ? prior.join(' → ') + ' → ' : '';
  }
}

const TASKBOARD_STATUS_ICON = {
  pending:     '☐',
  'in-progress': '⏳',
  done:        '☑',
};
const TASKBOARD_STATUS_COLOR = {
  pending:       'var(--text-muted)',
  'in-progress': 'var(--warn,#FEBC2E)',
  done:          'var(--success,#28C840)',
};

/**
 * Met à jour le panneau de tâches du terminal (Engine/TODO.org [#J] Axe 4)
 * à partir d'un événement SSE 'taskboard', lui-même dérivé de l'état
 * consolidé que ECA fournit nativement à chaque appel eca__task (plan/
 * start/complete/…) — voir eca-client.js#classifyToolCall § isTaskUpdate.
 * Checklist en direct : ☐ pending · ⏳ in-progress · ☑ done.
 */
function lvlTermUpdateTaskboard({ tasks, summary, activeSummary }) {
  const panel   = document.getElementById('lvl-term-taskboard');
  const sumEl   = document.getElementById('lvl-term-taskboard-summary');
  const listEl  = document.getElementById('lvl-term-taskboard-list');
  if (!panel || !listEl) return;
  panel.hidden = false;

  if (sumEl && summary) {
    sumEl.textContent =
      `${summary.done}/${summary.total} terminée(s)` +
      (summary.inProgress ? ` · ${summary.inProgress} en cours` : '') +
      (activeSummary ? ` — ${activeSummary}` : '');
  }

  listEl.innerHTML = (tasks || []).map(t => {
    const icon  = TASKBOARD_STATUS_ICON[t.status] || '☐';
    const color = TASKBOARD_STATUS_COLOR[t.status] || 'var(--text-muted)';
    const strike = t.status === 'done' ? 'text-decoration:line-through;opacity:.7' : '';
    return `<div style="display:flex;align-items:baseline;gap:6px;color:${color}">
      <span>${icon}</span>
      <span style="${strike}">#${t.id} ${escapeHtml(t.subject || '')}</span>
      ${t.isBlocked ? '<span style="color:var(--error,#EF4444);font-size:10px">⛔ bloquée</span>' : ''}
    </div>`;
  }).join('');
}

/**
 * Renders an enriched tool-call (icon + family + summary), with a clickable
 * fold to the full detail (tool output) when available.
 * `toolInfo` comes from eca-client.js#classifyToolCall — see its docs for
 * the field details { family, icon, label, name, hint, summary, detail,
 * isSubagent, agentName, subagentChatId, agentModel, agentStep }.
 *
 * Sub-agent case (isSubagent === true, tool "spawn_agent"): rendered as a
 * foldable SECTION (Engine/TODO.org [#J] Axe 5, étape 3) rather than a
 * single line — registered in _lvlTermSubagentSections by subagentChatId
 * so that subsequent 'subagent-tool' events (the sub-agent's OWN internal
 * tool calls — grep/read_file/etc. — see eca-client.js#subscribeEcaEvents
 * § onSubagentToolLog) can be appended inside this section instead of
 * polluting the main linear flow. If 'subagent-tool' events for this
 * subagentChatId already arrived BEFORE this final spawn_agent summary
 * (the common case — see lvlTermAppendSubagentTool, which creates a
 * placeholder section on first arrival), this call reuses and enriches
 * that existing section (header: agentName/agentModel, final result)
 * instead of creating a duplicate.
 */
function lvlTermAppendTool(toolInfo) {
  const out = document.getElementById('lvl-term-output');
  const color = TOOL_FAMILY_COLOR[toolInfo.family] || TOOL_FAMILY_COLOR.other;

  if (toolInfo.isSubagent && toolInfo.subagentChatId) {
    return lvlTermFinalizeSubagentSection(toolInfo, color);
  }

  const line = document.createElement('div');
  line.className = 'eca-session-line dim eca-tool-line';
  line.style.borderLeft = `2px solid ${color}`;

  const hasDetail = !!(toolInfo.detail && toolInfo.detail.trim());
  const head = document.createElement('div');
  head.className = 'eca-tool-head';
  head.style.cursor = hasDetail ? 'pointer' : 'default';

  const labelHtml = `<span class="eca-tool-label" style="color:${color}">${toolInfo.label || 'Outil'}</span>`;

  head.innerHTML =
    `<span class="eca-tool-icon">${toolInfo.icon || '⚙'}</span>` +
    labelHtml +
    `<span class="eca-tool-summary">${escapeHtml(toolInfo.summary || toolInfo.name || '…')}</span>` +
    (hasDetail ? `<span class="eca-tool-chevron">▸</span>` : '');
  line.appendChild(head);

  if (hasDetail) {
    const detail = document.createElement('pre');
    detail.className = 'eca-tool-detail hidden';
    detail.textContent = toolInfo.detail;
    line.appendChild(detail);
    head.onclick = () => {
      detail.classList.toggle('hidden');
      head.querySelector('.eca-tool-chevron').textContent =
        detail.classList.contains('hidden') ? '▸' : '▾';
    };
  }

  out.appendChild(line);
  lvlTermPruneOldLines();
  out.scrollTop = out.scrollHeight;
  return line;
}

/**
 * Crée (si absente) la section pliable DOM pour un sous-agent donné, et y
 * ajoute une ligne pour un tool-call interne reçu via l'événement SSE
 * 'subagent-tool' (Engine/TODO.org [#J] Axe 5, étape 3).
 * Appelée généralement AVANT lvlTermAppendTool/lvlTermFinalizeSubagentSection
 * pour ce même subagentChatId (le détail arrive en continu pendant que le
 * sous-agent travaille ; le résumé final n'arrive qu'à la toute fin) — la
 * section est donc créée ici en premier, avec un en-tête provisoire
 * ("agent…" sans nom tant que agentName n'est pas encore connu), puis
 * enrichie par lvlTermFinalizeSubagentSection une fois le spawn_agent
 * terminé.
 */
function lvlTermAppendSubagentTool(subagentChatId, toolInfo) {
  const out = document.getElementById('lvl-term-output');
  let section = _lvlTermSubagentSections.get(subagentChatId);

  if (!section) {
    const color = TOOL_FAMILY_COLOR.agent;
    const wrap = document.createElement('div');
    wrap.className = 'eca-session-line dim eca-tool-line eca-subagent-line';
    wrap.style.borderLeft = `3px solid ${color}`;

    const head = document.createElement('div');
    head.className = 'eca-tool-head';
    head.style.cursor = 'pointer';
    head.innerHTML =
      `<span class="eca-tool-icon">🤖</span>` +
      `<span class="eca-subagent-tag" style="color:${color};border-color:${color}">agent: …</span>` +
      `<span class="eca-tool-summary">en cours…</span>` +
      `<span class="eca-tool-chevron">▾</span>`;
    wrap.appendChild(head);

    const body = document.createElement('div');
    body.className = 'eca-subagent-body';
    wrap.appendChild(body);

    head.onclick = () => {
      body.classList.toggle('hidden');
      head.querySelector('.eca-tool-chevron').textContent =
        body.classList.contains('hidden') ? '▸' : '▾';
    };

    out.appendChild(wrap);
    section = { wrap, head, body, finalized: false };
    _lvlTermSubagentSections.set(subagentChatId, section);
  }

  const color = TOOL_FAMILY_COLOR[toolInfo.family] || TOOL_FAMILY_COLOR.other;
  const hasDetail = !!(toolInfo.detail && toolInfo.detail.trim());
  const subLine = document.createElement('div');
  subLine.className = 'eca-tool-head';
  subLine.style.cursor = hasDetail ? 'pointer' : 'default';
  subLine.style.paddingLeft = '14px';
  subLine.innerHTML =
    `<span class="eca-tool-icon">${toolInfo.icon || '⚙'}</span>` +
    `<span class="eca-tool-label" style="color:${color}">${toolInfo.label || 'Outil'}</span>` +
    `<span class="eca-tool-summary">${escapeHtml(toolInfo.summary || toolInfo.name || '…')}</span>` +
    (hasDetail ? `<span class="eca-tool-chevron">▸</span>` : '');

  if (hasDetail) {
    const detail = document.createElement('pre');
    detail.className = 'eca-tool-detail hidden';
    detail.textContent = toolInfo.detail;
    subLine.onclick = () => {
      detail.classList.toggle('hidden');
      subLine.querySelector('.eca-tool-chevron').textContent =
        detail.classList.contains('hidden') ? '▸' : '▾';
    };
    section.body.appendChild(subLine);
    section.body.appendChild(detail);
  } else {
    section.body.appendChild(subLine);
  }

  out.scrollTop = out.scrollHeight;
}

/**
 * Enrichit (ou crée si aucun 'subagent-tool' n'est jamais arrivé — cas d'un
 * sous-agent qui conclut sans exécuter d'outil, ex. réponse directe) la
 * section pliable d'un sous-agent avec son résultat final, une fois
 * l'événement spawn_agent/toolCalled reçu sur le chat parent.
 */
function lvlTermFinalizeSubagentSection(toolInfo, color) {
  const out = document.getElementById('lvl-term-output');
  let section = _lvlTermSubagentSections.get(toolInfo.subagentChatId);

  if (!section) {
    // Aucun détail de sous-agent capté (cas rare — ex. refus immédiat par
    // le sous-agent, voir test réel en session où un chemin hors workspace
    // produit une erreur textuelle sans aucun tool-call interne) : repli
    // sur l'ancien rendu ligne simple, pas de section vide à créer.
    const wrap = document.createElement('div');
    wrap.className = 'eca-session-line dim eca-tool-line eca-subagent-line';
    wrap.style.borderLeft = `3px solid ${color}`;
    const head = document.createElement('div');
    head.className = 'eca-tool-head';
    wrap.appendChild(head);
    out.appendChild(wrap);
    section = { wrap, head, body: null, finalized: false };
  }

  const { head } = section;
  const hasDetail = !!(toolInfo.detail && toolInfo.detail.trim());
  head.style.cursor = hasDetail || section.body ? 'pointer' : 'default';
  const stepHtml = toolInfo.agentStep
    ? `<span class="eca-subagent-step">étape ${toolInfo.agentStep}${toolInfo.agentMaxSteps ? '/' + toolInfo.agentMaxSteps : ''}</span>`
    : '';
  head.innerHTML =
    `<span class="eca-tool-icon">🤖</span>` +
    `<span class="eca-subagent-tag" style="color:${color};border-color:${color}">agent: ${escapeHtml(toolInfo.agentName || '?')}</span>` +
    stepHtml +
    `<span class="eca-tool-summary">${escapeHtml(toolInfo.summary || toolInfo.name || '…')}</span>` +
    (hasDetail ? `<span class="eca-tool-chevron">▸</span>` : '');
  if (toolInfo.agentModel) {
    head.title = `Sous-agent "${toolInfo.agentName}" — modèle ${toolInfo.agentModel}` +
      (toolInfo.subagentChatId ? ` — chat ${toolInfo.subagentChatId}` : '');
  }

  if (hasDetail) {
    const detail = document.createElement('pre');
    detail.className = 'eca-tool-detail hidden';
    detail.textContent = toolInfo.detail;
    section.wrap.appendChild(detail);
    head.onclick = () => {
      detail.classList.toggle('hidden');
      head.querySelector('.eca-tool-chevron').textContent =
        detail.classList.contains('hidden') ? '▸' : '▾';
    };
  }

  section.finalized = true;
  lvlTermPruneOldLines();
  out.scrollTop = out.scrollHeight;
  return section.wrap;
}

function levelTerminalKeydown(e) {
  const input = document.getElementById('lvl-term-input');
  if (e.key === 'Escape' && !input.value.trim() && _lvlTermAbortCtrl) {
    e.preventDefault();
    levelTerminalStop();
    return;
  }
  if ((e.key === 'r' || e.key === 'R') && e.altKey && !_lvlTermAbortCtrl && _lvlTermLastCmd) {
    e.preventDefault();
    levelTerminalExec(_lvlTermLastCmd);
    return;
  }
  if (e.key === 'Tab' && !input.value.trim()) {
    // Toggle fold de la dernière réponse foldable
    e.preventDefault();
    const out = document.getElementById('lvl-term-output');
    if (out) {
      const foldables = out.querySelectorAll('.eca-session-line.foldable');
      if (foldables.length) toggleFold(foldables[foldables.length - 1]);
    }
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    // Enter alone → submit; Shift+Enter → newline (default textarea behaviour)
    e.preventDefault();
    const cmd = input.value.trim();
    input.value = '';
    input.style.height = '';   // reset auto-grown height
    if (!cmd) return;
    _lvlTermHistory.unshift(cmd);
    _lvlTermHistIdx = -1;
    levelTerminalExec(cmd);
  } else if (e.key === 'ArrowUp' && !e.shiftKey) {
    // Only navigate history when caret is on the first line
    const atTop = input.selectionStart <= (input.value.indexOf('\n') || input.value.length);
    if (!atTop) return;
    e.preventDefault();
    if (_lvlTermHistIdx < _lvlTermHistory.length - 1) {
      _lvlTermHistIdx++;
      input.value = _lvlTermHistory[_lvlTermHistIdx];
    }
  } else if (e.key === 'ArrowDown' && !e.shiftKey) {
    const atBottom = input.selectionStart >= (input.value.lastIndexOf('\n') + 1);
    if (!atBottom) return;
    e.preventDefault();
    if (_lvlTermHistIdx > 0) {
      _lvlTermHistIdx--;
      input.value = _lvlTermHistory[_lvlTermHistIdx];
    } else {
      _lvlTermHistIdx = -1;
      input.value = '';
    }
  }
}

async function levelTerminalExec(cmd) {
  if (!_lvlTermCtx) return;
  const ctx    = _lvlTermCtx;
  const prompt = levelPromptLabel(ctx);

  const out = document.getElementById('lvl-term-output');
  const cmdLine = document.createElement('div');
  cmdLine.className = 'eca-session-line cmd';
  cmdLine.innerHTML = `<span class="eca-ps">${escapeHtml(prompt)}</span> ${escapeHtml(cmd)}`;
  out.appendChild(cmdLine);
  lvlTermPruneOldLines();
  out.scrollTop = out.scrollHeight;

  if (cmd.toLowerCase() === 'clear') { out.innerHTML = ''; return; }

  _lvlTermLastCmd = cmd;
  _lvlTermStartTs = Date.now();

  // Spinner animé + timer
  const thinking = document.createElement('div');
  thinking.className = 'eca-session-line dim lvl-term-thinking';
  thinking.innerHTML = '<span class="lvl-term-spinner"></span><span class="lvl-term-elapsed">0s</span>';
  out.appendChild(thinking);
  out.scrollTop = out.scrollHeight;
  const elapsedEl = thinking.querySelector('.lvl-term-elapsed');
  const timerInterval = setInterval(() => {
    if (elapsedEl) elapsedEl.textContent = Math.round((Date.now() - _lvlTermStartTs) / 1000) + 's';
  }, 1000);

  const input = document.getElementById('lvl-term-input');
  if (input) input.disabled = true;

  // Bouton Stop visible
  const stopBtn = document.getElementById('lvl-term-stop-btn');
  if (stopBtn) stopBtn.hidden = false;

  // AbortController pour ce fetch
  _lvlTermAbortCtrl = new AbortController();

  // ── Read the SSE streaming response ──────────────────────────────
  // ROUTE 5bis now returns text/event-stream:
  //   event: chunk   data: { text }          ← streamed token
  //   event: tool    data: { summary }       ← tool call in progress
  //   event: ask     data: { question, toolId, chatId } ← ask_user ECA
  //   event: ping    data: { t }             ← keepalive
  //   event: done    data: {}                ← normal end
  //   event: error   data: { message }       ← error
  let replyLine = null;  // ligne accumulatrice pour les chunks
  let thinkingRemoved = false;
  let doneShown = false;   // vrai dès qu'un badge de fin a été affiché

  function ensureThinkingRemoved() {
    if (!thinkingRemoved) {
      clearInterval(timerInterval);
      thinking.remove();
      thinkingRemoved = true;
    }
  }

  try {
    const resp = await fetch(`${API}/api/sandboxes/${ctx.sbId}/terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: _lvlTermAbortCtrl.signal,
      body: JSON.stringify({
        level:      ctx.level,
        entityId:   ctx.entityId,
        projId:     ctx.projId,
        reportFile: ctx.reportFile,
        sessionId:  _lvlTermSessionId,
        message:    cmd,
        timeoutMinutes: ctx.kind === 'strengthen'
          ? Math.min(SETTINGS.eca.terminalTimeoutMinutes, 45)
          : SETTINGS.eca.terminalTimeoutMinutes,
        kind:       ctx.kind || null,
      }),
    });

    if (!resp.ok || !resp.body) {
      ensureThinkingRemoved();
      let errMsg = 'erreur réseau';
      try { const d = await resp.json(); errMsg = d.error || errMsg; } catch {}
      lvlTermAppend(`✖ ${errMsg}`, 'err');
    } else {
      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop();
        for (const block of blocks) {
          if (!block.trim()) continue;
          const evtM = block.match(/^event:\s*(\S+)/m);
          const datM = block.match(/^data:\s*(.+)/m);
          if (!evtM) continue;
          const evt = evtM[1];
          let data = {};
          if (datM) { try { data = JSON.parse(datM[1]); } catch {} }

          if (evt === 'chunk') {
            ensureThinkingRemoved();
            if (!replyLine) replyLine = lvlTermAppend('', 'resp');
            // append plain text; render markdown later on done
            replyLine.textContent += data.text || '';
            out.scrollTop = out.scrollHeight;

          } else if (evt === 'tool') {
            ensureThinkingRemoved();
            lvlTermAppendTool(data);

          } else if (evt === 'skill') {
            lvlTermUpdateSkillBanner(data);

          } else if (evt === 'taskboard') {
            lvlTermUpdateTaskboard(data);

          } else if (evt === 'subagent-tool') {
            ensureThinkingRemoved();
            lvlTermAppendSubagentTool(data.subagentChatId, data.toolInfo);

          } else if (evt === 'ask') {
            ensureThinkingRemoved();
            replyLine = null; // nouvelle réponse après la question
            lvlTermAskUser(ctx, data.question || '', data.toolId, data.isApproval, data.options);

          } else if (evt === 'refresh') {
            // Live refresh de l'onglet Tests (WEB-021) — déclenché par
            // server/routes/terminal.js quand ECA écrit un fichier clé
            // (.last-check-results.json, .last-strengthen-report.json)
            // AVANT le DONE final. Met à jour les badges de convergence
            // et le strengthen panel sans attendre la fin du terminal.
            refreshSandboxReports(ctx.sbId);

          } else if (evt === 'ping') {
            // keepalive — update the "thinking" message if still visible
            if (!thinkingRemoved) thinking.textContent = `… ECA réfléchit … (${Math.round((Date.now() - _lvlTermStartTs) / 1000)}s)`;

          } else if (evt === 'error') {
            ensureThinkingRemoved();
            lvlTermAppend(`✖ Erreur eca-server : ${data.message || '?'}`, 'err');
            break outer;

          } else if (evt === 'done') {
            ensureThinkingRemoved();
            // Clean up the textual "DONE" marker that ECA sometimes writes at
            // the end of a response (cf. DONE_INSTRUCTION in server.js), but
            // the badge is now UNCONDITIONAL: the end of processing is signalled
            // by event:done itself, not by the presence of the word in the text.
            if (replyLine) {
              const raw = replyLine.textContent;
              if (/\s*\bDONE\b\s*$/.test(raw)) {
                replyLine.textContent = raw.replace(/\s*\bDONE\b\s*$/, '').trimEnd();
              }
            }
            doneShown = true;
            lvlTermResetAskBanner(); // Fix A+C : cacher bannière + restaurer titre
            // Fold long responses + Markdown rendering
            if (replyLine) {
              renderMarkdownInline(replyLine);
              maybeFoldResponse(replyLine);
            }
            const elapsed = Math.round((Date.now() - _lvlTermStartTs) / 1000);
            const doneLine = lvlTermAppend(`✅ Terminé (${elapsed}s)`, 'ok done-badge');
            if (_lvlTermLastCmd) {
              const retryBtn = document.createElement('button');
              retryBtn.className = 'lvl-term-retry-btn';
              retryBtn.textContent = '↻ Retry';
              const lastCmd = _lvlTermLastCmd;
              retryBtn.onclick = () => levelTerminalExec(lastCmd);
              doneLine.appendChild(retryBtn);
            }
            // Visual separator between exchanges
            const sep = document.createElement('hr');
            sep.className = 'lvl-term-sep';
            out.appendChild(sep);
            // Persist the frozen exchange (see § Lightweight terminal history
            // persistence) — never during active streaming,
            // only once the exchange is actually complete.
            lvlTermSaveHistory();
            // Un run.pl/chorus-check/chorus-complete-report lancé depuis ce
            // terminal ('project'/'report') peut avoir produit de nouveaux
            // rapports sur le filesystem — rescanner le sandbox pour que
            // PROJECTS[...]/_lastReports (et donc le bouton 📊 View, la liste
            // report lists, etc.) reflect these files without waiting for an F5.
            // 'sandbox' est inclus aussi : c'est le niveau utilisé par
            // l'onglet Tests (runTestingStrategy → chorus-check <sb> <file>)
            // — sans ce rescan, les badges de convergence/lastRun de l'onglet
            // Tests restaient figés sur l'état précédent après un test lancé
            // depuis ce terminal.
            if (ctx.level === 'sandbox' || ctx.level === 'project' || ctx.level === 'report') {
              refreshSandboxReports(ctx.sbId);
            }
            break outer;
          }
        }
      }
      ensureThinkingRemoved();
      // Fallback: the stream closed (reader.done) without an explicit event:done
      // (e.g. network cut, server crash). End is signalled anyway.
      if (!doneShown) {
        const elapsed = Math.round((Date.now() - _lvlTermStartTs) / 1000);
        lvlTermResetAskBanner();
        lvlTermAppend(`⏸ Session terminée (${elapsed}s)`, 'dim done-badge');
        doneShown = true;
        lvlTermSaveHistory();
        if (ctx.level === 'sandbox' || ctx.level === 'project' || ctx.level === 'report') {
          refreshSandboxReports(ctx.sbId);
        }
      }
    }
  } catch (e) {
    ensureThinkingRemoved();
    if (e.name === 'AbortError') {
      lvlTermAppend('⏹ Génération annulée', 'warn');
    } else {
      lvlTermAppend(`✖ Erreur réseau : ${e.message}`, 'err');
    }
  } finally {
    _lvlTermAbortCtrl = null;
    const stopBtn = document.getElementById('lvl-term-stop-btn');
    if (stopBtn) stopBtn.hidden = true;
    if (input) { input.disabled = false; if (!_lvlTermMinimized) input.focus(); }
    out.scrollTop = out.scrollHeight;
    // If the terminal was minimised during generation, update the floating
    // indicator ("in progress…" dot → "done") rather than leaving a
    // frozen state until the terminal is reopened.
    if (_lvlTermMinimized) showMinimizedTerminalIndicator();
  }
}

// ─── TERMINAL HELPERS ─────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/** Compact report count label: "1 run" or "1 run · 13 analyses" */
function reportCountLabel(reports) {
  const reps = reports || [];
  const runN = reps.filter(r => r.kind === 'run').length;
  const anlN = reps.filter(r => r.kind === 'summary' || r.kind === 'explain').length;
  if (!runN && !anlN) return '0';
  if (!anlN) return `${runN}`;
  if (!runN) return `${anlN} analyses`;
  return `${runN} run · ${anlN} analyses`;
}

/**
 * Displays the question asked by ECA (ask_user).
 * - Shows a STICKY BANNER above the scrollable output (always visible).
 * - If options[] are provided, renders clickable buttons (no need to type).
 * - Always also renders an inline text input for freeform answers.
 * - Updates the terminal title with a "⏸" badge (Fix C).
 * The response is submitted via POST /terminal/respond.
 */
function lvlTermAskUser(ctx, question, toolId, isApproval = false, options = []) {
  const out    = document.getElementById('lvl-term-output');
  const banner = document.getElementById('lvl-term-ask-banner');
  const bannerQ = document.getElementById('lvl-term-ask-question');
  const title  = document.getElementById('lvl-term-title');

  // ── Fix A : bannière sticky ───────────────────────────────────────────
  if (banner) {
    if (bannerQ) bannerQ.textContent = question;
    banner.hidden = false;
  }
  // ── Fix C : badge pulsant sur le titre ────────────────────────────────
  if (title && !title.dataset.origTitle) title.dataset.origTitle = title.textContent;
  if (title) title.textContent = `⏸ En attente — ${title.dataset.origTitle || 'ECA'}`;

  // ── Ligne question dans le flux ────────────────────────────────────────
  const qLine = document.createElement('div');
  qLine.className = 'eca-session-line warn';
  qLine.textContent = isApproval ? `🔐 ECA — ${question}` : `❓ ECA — ${question}`;
  out.appendChild(qLine);

  // ── Fix B : boutons d'options cliquables ─────────────────────────────
  const wrap = document.createElement('div');
  wrap.className = 'eca-ask-user-wrap';
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:6px 0';

  const optList = Array.isArray(options) ? options : [];
  if (optList.length) {
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding-left:4px';
    optList.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost btn-sm';
      btn.style.cssText = 'font-size:11px;border:1px solid var(--warn,#FEBC2E);color:var(--warn,#FEBC2E)';
      btn.textContent = opt.label || opt;
      btn.title = opt.description || '';
      btn.onclick = () => submitAnswer(opt.label || opt);
      btnRow.appendChild(btn);
    });
    wrap.appendChild(btnRow);
  }

  // Champ texte libre (toujours présent — fallback ou réponse libre)
  const inputRow = document.createElement('div');
  inputRow.style.cssText = 'display:flex;align-items:center;gap:6px';
  inputRow.innerHTML = `
    <span class="eca-session-prompt-label" style="color:var(--warn)">réponse ?›</span>
    <input class="eca-session-input" style="flex:1;border:none;outline:none;font-size:12px;
      font-family:'JetBrains Mono',monospace;color:#E6EDF3;background:transparent;caret-color:#F59E0B"
      placeholder="${optList.length ? 'ou tapez une réponse libre…' : 'Tapez votre réponse et appuyez sur Entrée…'}"
      autocomplete="off" spellcheck="false">
  `;
  wrap.appendChild(inputRow);
  out.appendChild(wrap);
  out.scrollTop = out.scrollHeight;

  const answerInput = wrap.querySelector('input');
  if (answerInput) answerInput.focus();

  async function submitAnswer(answer) {
    if (!(answer || '').trim()) return;
    wrap.remove();

    // Cacher la bannière et restaurer le titre
    if (banner) banner.hidden = true;
    if (title && title.dataset.origTitle) {
      title.textContent = title.dataset.origTitle;
      delete title.dataset.origTitle;
    }

    const aLine = document.createElement('div');
    aLine.className = 'eca-session-line cmd';
    aLine.innerHTML = `<span style="color:var(--warn)">réponse ?›</span> ${escapeHtml(answer)}`;
    out.appendChild(aLine);
    out.scrollTop = out.scrollHeight;

    try {
      await fetch(`${API}/api/sandboxes/${ctx.sbId}/terminal/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: answer, sessionId: _lvlTermSessionId }),
      });
    } catch (e) {
      lvlTermAppend(`✖ Erreur envoi réponse : ${e.message}`, 'err');
    }
  }

  if (answerInput) {
    answerInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitAnswer((answerInput.value || '').trim());
      }
    });
  }

  // Cacher la bannière aussi quand le terminal se ferme (DONE)
  // → géré dans lvlTermResetAskBanner() appelé sur event:done
}

/** Réinitialise la bannière "En attente" et le titre du terminal.
 *  Appelée à la fin de chaque session (event:done, stop, error). */
function lvlTermResetAskBanner() {
  const banner = document.getElementById('lvl-term-ask-banner');
  if (banner) banner.hidden = true;
  const title = document.getElementById('lvl-term-title');
  if (title && title.dataset.origTitle) {
    title.textContent = title.dataset.origTitle;
    delete title.dataset.origTitle;
  }
}

// ─── MARKDOWN INLINE ──────────────────────────────────────────
// Applied to a .resp element after event:done (never during streaming).
// Renderer minimal sans dépendance externe.
function renderMarkdownInline(el) {
  // Sauvegarder le texte brut pour Copy / Fold
  if (!el.dataset.rawText) el.dataset.rawText = el.textContent;

  let t = el.textContent;

  // Escape residual HTML (security)
  t = t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Blocs de code (``` ... ```) — avant tout le reste
  t = t.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre class="md-code"${lang ? ` data-lang="${lang}"` : ''}><code>${code}</code></pre>`);

  // Code inline `…`
  t = t.replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>');

  // Titres
  t = t.replace(/^### (.+)$/gm, '<h4 class="md-h4">$1</h4>');
  t = t.replace(/^## (.+)$/gm,  '<h3 class="md-h3">$1</h3>');
  t = t.replace(/^# (.+)$/gm,   '<h2 class="md-h2">$1</h2>');

  // Gras / italique
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*(.+?)\*/g,     '<em>$1</em>');

  // Listes (- ou *)
  t = t.replace(/^[ \t]*[-\*] (.+)$/gm, '<li class="md-li">$1</li>');
  t = t.replace(/(<li[^>]*>[\s\S]*?<\/li>\n?)+/g, '<ul class="md-ul">$&</ul>');

  // Tableaux Markdown pipe (ex. "| Ordre | Règle | Référence corpus |" suivi
  // d'une ligne séparatrice "|---|---|---|") — sans ce bloc, ces lignes
  // n'étaient jamais reconnues comme un tableau et s'affichaient telles
  // quelles (pipes littéraux) une fois les retours à la ligne convertis en
  // <br> par le bloc suivant (cf. rapport chorus-check --explain, section
  // "Chaîne de règles (_rule_trace)"). Un bloc de tableau = au moins 2
  // lignes commençant par "|", la 2e étant une ligne séparatrice
  // (uniquement des "-", "|", ":" et espaces).
  t = t.replace(/^((?:\|.*\|[ \t]*\n){2,})/gm, (block) => {
    const lines = block.replace(/\n$/, '').split('\n');
    if (lines.length < 2) return block;
    const isSep = (l) => /^\|?[ \t:|-]+\|?$/.test(l.trim()) && /-/.test(l);
    if (!isSep(lines[1])) return block;
    const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    const header = splitRow(lines[0]);
    const bodyRows = lines.slice(2).map(splitRow);
    let html = '<table class="md-table"><thead><tr>';
    header.forEach(c => { html += `<th>${c}</th>`; });
    html += '</tr></thead><tbody>';
    bodyRows.forEach(row => {
      html += '<tr>';
      row.forEach(c => { html += `<td>${c}</td>`; });
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  });

  // Sauts de ligne résiduels (hors blocs pre)
  // On préserve les newlines dans les pre ; on convertit les autres
  const parts = t.split(/(<pre[\s\S]*?<\/pre>)/);
  t = parts.map((p, i) =>
    i % 2 === 0 ? p.replace(/\n/g, '<br>') : p
  ).join('');

  el.innerHTML = t;
}

// ─── FOLD / UNFOLD ────────────────────────────────────────────
const FOLD_THRESHOLD = 20; // lignes

function maybeFoldResponse(el) {
  // Utiliser rawText (texte brut) si disponible (après renderMarkdownInline)
  const raw = el.dataset.rawText || el.textContent;
  const lines = raw.split('\n');
  if (lines.length < FOLD_THRESHOLD) return;
  el.dataset.fullText = raw;
  el.dataset.folded = '1';
  el.classList.add('foldable');
  // Show the first 4 lines + toggle
  el.textContent = lines.slice(0, 4).join('\n') + '\n…';
  const toggle = document.createElement('button');
  toggle.className = 'lvl-term-fold-toggle';
  toggle.textContent = `▶ ${lines.length} lignes — cliquer pour déplier`;
  toggle.onclick = () => toggleFold(el);
  el.appendChild(toggle);
}

function toggleFold(el) {
  const out = document.getElementById('lvl-term-output');
  if (el.dataset.folded === '1') {
    // Expand: restore raw text then re-render Markdown
    el.dataset.folded = '0';
    el.textContent = el.dataset.fullText;
    renderMarkdownInline(el);
    const toggle = document.createElement('button');
    toggle.className = 'lvl-term-fold-toggle';
    const n = el.dataset.fullText.split('\n').length;
    toggle.textContent = `▲ Replier (${n} lignes)`;
    toggle.onclick = () => toggleFold(el);
    el.appendChild(toggle);
  } else {
    // Replier : revenir au texte brut tronqué
    el.dataset.folded = '1';
    const lines = (el.dataset.fullText || '').split('\n');
    el.textContent = lines.slice(0, 4).join('\n') + '\n…';
    const toggle = document.createElement('button');
    toggle.className = 'lvl-term-fold-toggle';
    toggle.textContent = `▶ ${lines.length} lignes — cliquer pour déplier`;
    toggle.onclick = () => toggleFold(el);
    el.appendChild(toggle);
  }
  if (out) out.scrollTop = out.scrollHeight;
}

// ─── IMPORT ───────────────────────────────────────────────────
function openHistoryModal(projId) {
  const sbId = currentSandbox ? currentSandbox.id : null;
  const proj = (PROJECTS[sbId]||[]).find(p=>p.id===projId);
  if (!proj) return;
  document.getElementById('hm-proj-name').textContent = proj.name;
  // Find context path
  const ctx = (ENTITIES[sbId]||[]).find(c=>c.id===proj.entity) || (ENTITIES[sbId]||[])[0];
  const ctxPath = ctx ? `$workspace/${sbId}/${ctx.path}/${projId}.json` : `$workspace/${sbId}/.../${projId}.json`;
  document.getElementById('hm-proj-path').textContent = ctxPath;

  const body = document.getElementById('hm-body');
  const reports = proj.reports || [];

  if (reports.length === 0) {
    body.innerHTML = '<div class="hm-empty">Aucun rapport généré pour ce projet.<br><span style="font-size:11px">Lancez <code>run.pl</code> ou <code>chorus-check</code> pour produire des rapports.</span></div>';
  } else {
    // summary/explain sont accessibles via les boutons "Summary" /
    // "Explain" du panneau de vue d'un rapport de pipeline — on les
    // excluded from the list to avoid redundancy.
    const analyses = reports.filter(r => r.kind === 'summary' || r.kind === 'explain');

    // Group run-reports by date (summary/explain exclus)
    const byDate = {};
    for (const r of reports) {
      if (r.kind === 'summary' || r.kind === 'explain') continue;
      const d = r.date || 'Inconnu';
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(r);
    }
    // Sort dates descending
    const dates = Object.keys(byDate).sort((a,b)=>b.localeCompare(a));
    let html = '';
    for (const d of dates) {
      const reps = sortReportsByDateDesc(byDate[d]);
      // Collect unique run commands for this date
      const runs = [...new Set(reps.map(r=>r.run||'run.pl'))];
      html += `<div class="hm-run-group">
        <div class="hm-run-label">
          ${d}
          ${runs.map(r=>`<span class="hm-run-badge">${r}</span>`).join('')}
        </div>`;
      for (const r of reps) {
        const isMd   = r.label && r.label.endsWith('.md');
        const isJson = r.kind === 'run' && r.label && r.label.endsWith('.json');
        let viewBtn = '';
        if (isMd) {
          viewBtn = `<button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:10px;flex-shrink:0" title="Voir ${r.label}" onclick="openMdView('${sbId}', '${proj.entity}', '${projId}', '${r.label}')">👁️</button>`;
        } else if (isJson) {
          viewBtn = `<button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:10px;flex-shrink:0" title="Voir ${r.label} (rapport structuré run.pl)" onclick="openReportView({label:'${r.label}', kind:'run', run:'run.pl'}, {sbId:'${sbId}', sbName:'${(currentSandbox&&currentSandbox.name)||sbId}', entityId:'${proj.entity}', projId:'${projId}', projName:'${proj.name}'})">👁️</button>`;
        }
        // 📋 summary / 💡 explain icons — only on run-reports (.json)
        const miniIcons = isJson ? reportMiniIcons(r, sbId, proj.entity, projId) : '';

        html += `<div class="hm-report-row">
          <div class="hm-report-icon">${r.icon||'📋'}</div>
          <div class="hm-report-info">
            <div class="hm-report-name">${r.label}</div>
            <div class="hm-report-desc">${r.desc||''}</div>
          </div>
          <div class="hm-report-path" title="${r.path||''}">${r.path||''}</div>
          <div style="display:flex;align-items:center;gap:2px;flex-shrink:0">
            ${miniIcons}
            ${viewBtn}
            <button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:10px;flex-shrink:0" title="Terminal ECA — rapport ${r.label}" onclick="openLevelTerminal('report', {sbId:'${sbId}', entityId:'${proj.entity}', projId:'${projId}', projName:'${(proj.name||'').replace(/'/g,"\\'")}', reportFile:'${r.label}', explainFile:${r.explain_file ? `'${r.explain_file}'` : 'null'}, syntheseFile:${r.synthese_file ? `'${r.synthese_file}'` : 'null'}})">🖥️</button>
          </div>
        </div>`;
      }
      html += '</div>';
    }
    // Section "Analyses" séparée — les fichiers summary/explain ne sont pas
    // structurellement liés à un run-report spécifique (pas de référence
    // cross-linked in the data). They are displayed in a separate section
    // to avoid any false association with a particular run.
    if (analyses.length) {
      const sortedAnalyses = sortReportsByDateDesc(analyses);
      html += `<div style="margin-top:14px">
        <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">
          Analyses (${analyses.length}) — non liées à un run spécifique
        </div>`;
      for (const r of sortedAnalyses) {
        const icon = r.kind === 'summary' ? '📋' : '💡';
        const label = r.kind === 'summary' ? 'Summary' : 'Explain';
        html += `<div class="hm-report-row">
          <div class="hm-report-icon">${icon}</div>
          <div class="hm-report-info">
            <div class="hm-report-name">${r.label}</div>
            <div class="hm-report-desc">${r.desc||''}${r.date ? ` · ${r.date}` : ''}</div>
          </div>
          <div class="hm-report-path" title="${r.path||''}">${r.path||''}</div>
          <button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:10px;flex-shrink:0"
            title="Voir ${r.label}"
            onclick="openMdView('${sbId}', '${proj.entity}', '${projId}', '${r.label}')">👁️ ${label}</button>
          <button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:10px;flex-shrink:0"
            title="Terminal ECA — ${r.label}"
            onclick="openLevelTerminal('report', {sbId:'${sbId}', entityId:'${proj.entity}', projId:'${projId}', projName:'${(proj.name||'').replace(/'/g,"\\'")}', reportFile:'${r.label}', explainFile:${r.kind === 'explain' ? `'${r.label}'` : 'null'}, syntheseFile:${r.kind === 'summary' ? `'${r.label}'` : 'null'}})">🖥️</button>
        </div>`;
      }
      html += `</div>`;
    }
    body.innerHTML = html;
  }

  document.getElementById('history-modal-overlay').hidden = false;
}

function closeHistoryModal() {
  document.getElementById('history-modal-overlay').hidden = true;
}

// ─── ORG-MODE RENDERER ──────────────────────────────────────────
// Lightweight Org-mode → HTML converter for import-report-*.org files.
// Handles: #+TITLE/KEYWORDS header, * headings, #+BEGIN_SRC/QUOTE/EXAMPLE,
// org pipe tables, - lists, inline ~code~ *bold* /italic/ markup.
// Output uses standard HTML elements (.mdv-content h1/h2/table/pre/blockquote)
// so the existing CSS applies without modification (except .org-meta below).

function _orgEsc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _orgInline(s) {
  let r = _orgEsc(s);
  // ~code~ and =verbatim=
  r = r.replace(/~([^~\n]{1,100})~/g,    '<code>$1</code>');
  r = r.replace(/=([^=\n]{1,100})=/g,    '<code>$1</code>');
  // *bold* — only between word boundaries / spaces (avoid false matches in tables)
  r = r.replace(/(^|[\s(])\*([^*\n]{1,120})\*(?=$|[\s),.])/gm, '$1<strong>$2</strong>');
  // /italic/
  r = r.replace(/(^|[\s(])\/([^/\n]{1,80})\/(?=$|[\s),.])/gm, '$1<em>$2</em>');
  return r;
}

function _orgTable(lines) {
  const isSep = l => /^\s*\|[-+| \t]+\|\s*$/.test(l) && !/[^|\-+ \t]/.test(l);
  const dataLines = lines.filter(l => !isSep(l));
  const sepIdx    = lines.findIndex(isSep);

  function rowHtml(line, tag) {
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    return '<tr>' + cells.map(c => `<${tag}>${_orgInline(c)}</${tag}>`).join('') + '</tr>';
  }

  if (sepIdx < 1) {
    // No separator → all tbody
    return '<table>' + dataLines.map(l => rowHtml(l, 'td')).join('') + '</table>';
  }

  const headLines = lines.slice(0, sepIdx).filter(l => !isSep(l));
  const bodyLines = lines.slice(sepIdx + 1).filter(l => !isSep(l));
  return '<table>'
    + '<thead>' + headLines.map(l => rowHtml(l, 'th')).join('') + '</thead>'
    + '<tbody>' + bodyLines.map(l => rowHtml(l, 'td')).join('') + '</tbody>'
    + '</table>';
}

function renderOrgMode(src) {
  const lines = src.split('\n');
  const out   = [];
  let i       = 0;

  // ── Collect #+KEYWORD: header lines at the very top ────────────────────
  const meta = {};
  while (i < lines.length && /^#\+\w/.test(lines[i])) {
    const m = lines[i].match(/^#\+(\w+):\s*(.*)/);
    if (m && !/^(BEGIN|END)_/i.test(m[1])) meta[m[1].toUpperCase()] = m[2].trim();
    i++;
  }

  if (meta.TITLE) out.push(`<h1>${_orgEsc(meta.TITLE)}</h1>`);
  const bits = [];
  if (meta.DATE)    bits.push(`📅 ${_orgEsc(meta.DATE)}`);
  if (meta.SANDBOX) bits.push(`🗂 ${_orgEsc(meta.SANDBOX)}`);
  if (meta.CONTEXT) bits.push(`🏢 ${_orgEsc(meta.CONTEXT)}`);
  if (bits.length) out.push(`<div class="org-meta">${bits.join('&emsp;·&emsp;')}</div>`);

  // ── Body ────────────────────────────────────────────────────────────────
  let paraLines = [];

  function flushPara() {
    const txt = paraLines.join('\n').trim();
    if (txt) out.push(`<p>${_orgInline(txt)}</p>`);
    paraLines = [];
  }

  while (i < lines.length) {
    const line = lines[i];

    // Ignore stray #+KEY: lines in body
    if (/^#\+\w+:/.test(line) && !/^#\+(BEGIN|END)_/i.test(line)) { i++; continue; }

    // #+BEGIN_xxx … #+END_xxx blocks
    const bm = line.match(/^#\+BEGIN_(\w+)/i);
    if (bm) {
      flushPara();
      const kind = bm[1].toUpperCase();
      const blockLines = [];
      i++;
      while (i < lines.length && !/^#\+END_/i.test(lines[i])) { blockLines.push(lines[i]); i++; }
      i++; // consume #+END_xxx
      const raw = blockLines.join('\n').replace(/^\n+|\n+$/g, '');
      if      (kind === 'SRC')   out.push(`<pre><code>${_orgEsc(raw)}</code></pre>`);
      else if (kind === 'QUOTE') out.push(`<blockquote>${_orgInline(raw)}</blockquote>`);
      else                       out.push(`<pre class="org-example">${_orgEsc(raw)}</pre>`);
      continue;
    }

    // * Headings  ** Sub  *** Sub-sub  (→ h2, h3, h4)
    const hm = line.match(/^(\*+) +(.*)/);
    if (hm) {
      flushPara();
      const lvl = Math.min(hm[1].length + 1, 5); // * → h2, ** → h3, *** → h4, **** → h5
      out.push(`<h${lvl}>${_orgInline(hm[2])}</h${lvl}>`);
      i++; continue;
    }

    // Org pipe tables
    if (/^\s*\|/.test(line)) {
      flushPara();
      const tLines = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { tLines.push(lines[i]); i++; }
      out.push(_orgTable(tLines));
      continue;
    }

    // - / + Unordered list
    if (/^[ \t]*[-+] /.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^[ \t]*[-+] /.test(lines[i])) {
        items.push(lines[i].replace(/^[ \t]*[-+] /, ''));
        i++;
      }
      out.push('<ul>' + items.map(t => `<li>${_orgInline(t)}</li>`).join('') + '</ul>');
      continue;
    }

    // N. Ordered list
    if (/^[ \t]*\d+\. /.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^[ \t]*\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^[ \t]*\d+\. /, ''));
        i++;
      }
      out.push('<ol>' + items.map(t => `<li>${_orgInline(t)}</li>`).join('') + '</ol>');
      continue;
    }

    // Blank line → flush paragraph
    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }

    // Regular text line → accumulate
    paraLines.push(line);
    i++;
  }

  flushPara();
  return out.join('\n');
}

// ─── MARKDOWN REPORT VIEWER ─────────────────────────────────────
// Displays the real content of a .md report (explain-/synthese-/
// compliance-report-) rendered as HTML via marked.js.
async function openMdView(sbId, entityId, projId, filename) {
  _mdvCtx = { sbId, entityId, projId, filename };
  document.getElementById('mdv-title').textContent = filename;
  document.getElementById('mdv-sub').textContent = `${sbId} / ${entityId} / ${projId}`;
  document.getElementById('mdv-content').innerHTML = 'Chargement…';
  const crossArea = document.getElementById('mdv-cross-area');
  if (crossArea) crossArea.innerHTML = '';
  updateMdvTerminalArea(sbId, entityId, projId, filename);
  document.getElementById('md-view-overlay').hidden = false;

  try {
    const r = await fetch(`${API}/api/sandboxes/${sbId}/entities/${entityId}/projects/${projId}/reports/${filename}`);
    if (!r.ok) throw new Error(await r.text());
    const text = await r.text();
    const isOrg = filename.endsWith('.org');
    document.getElementById('mdv-content').innerHTML =
      isOrg
        ? renderOrgMode(text)
        : (typeof marked !== 'undefined') ? marked.parse(text) : `<pre>${text}</pre>`;
    updateMdvCrossArea(filename, text);
  } catch (e) {
    document.getElementById('mdv-content').innerHTML =
      `<div style="color:var(--error);font-size:12px">Impossible de charger ${filename} : ${e.message}</div>`;
    if (crossArea) crossArea.innerHTML = '';
  }
}

function closeMdView() {
  _mdvCtx = null;
  document.getElementById('md-view-overlay').hidden = true;
}

// "💾 Save as HTML/PDF" button in the Markdown viewer panel — calls
// server.js § ROUTE export directly (scripts/md2html.py / md2pdf.py as a
// subprocess, never via an ECA skill — deterministic conversion, no LLM
// required). Direct download of the converted file; nothing is persisted
// in the sandbox.
async function exportMdReport(format) {
  if (!_mdvCtx) return;
  const { sbId, entityId, projId, filename } = _mdvCtx;
  const url = `${API}/api/sandboxes/${sbId}/entities/${entityId}/projects/${projId}/reports/${filename}/export/${format}`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${r.status}`);
    }
    const blob = await r.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename.replace(/\.(md|org)$/, `.${format}`);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  } catch (e) {
    alert(`Export ${format.toUpperCase()} échoué : ${e.message}`);
  }
}

// "🖥️ Terminal ECA" button in the Markdown viewer footer — visible only for
// explain-*.md reports (explicit request; other kinds — synthese-/compliance-report-
// already have their own terminal button on their row in the report lists,
// cf. pvReportButtons/openHistoryModal). Opens the ECA terminal at 'report'
// level, same parameter convention as other entry points (explainFile set,
// syntheseFile null).
function updateMdvTerminalArea(sbId, entityId, projId, filename) {
  const area = document.getElementById('mdv-terminal-area');
  if (!area) return;

  const isExplain = filename && filename.startsWith('explain-') && filename.endsWith('.md');
  if (!isExplain) { area.innerHTML = ''; return; }

  const proj = (PROJECTS[sbId] || []).find(p => p.id === projId);
  const projName = (proj?.name || '').replace(/'/g, "\\'");

  area.innerHTML = `<button class="btn btn-ghost btn-sm"
    title="Terminal ECA — ${filename}"
    onclick="openLevelTerminal('report', {sbId:'${sbId}', entityId:'${entityId}', projId:'${projId}', projName:'${projName}', reportFile:'${filename}', explainFile:'${filename}', syntheseFile:null})">🖥️ Terminal ECA</button>`;
}

// ─── CROSS-CHECK STATUS (explain-*.md viewer) ─────────────────────────────
//
// Detects whether the explain report has already been enriched by chorus-complete-report
// (Phase C4 inserts "Vérification croisée (chorus-complete-report, YYYY-MM-DD)").
// Displays either an "enriched" badge (green) or a "Cross-check source" button
// that opens the ECA terminal pre-contextualised with the chorus-complete-report command.

function updateMdvCrossArea(filename, content) {
  const crossArea = document.getElementById('mdv-cross-area');
  if (!crossArea) return;

  // Applies only to explain-*.md reports
  const isExplain = filename && filename.startsWith('explain-') && filename.endsWith('.md');
  if (!isExplain) { crossArea.innerHTML = ''; return; }

  const status = detectCompleteReportDone(content);

  if (status && status.kind === 'nothing') {
    // Zero-target guard — nothing to cross-check (no ❓ uncertain elements).
    // Neutral badge distinct from "✅ Cross-checked with source": the cross-check
    // did run, but there was structurally nothing to do. Prevents a user,
    // seeing the "🔀 Cross-check source" button still active, from re-running
    // the skill in a loop thinking it never ran.
    crossArea.innerHTML =
      `<span class="mdv-cross-badge mdv-cross-badge-neutral" title="chorus-complete-report a été exécuté — aucun élément ❓ incertain à cross-checker dans ce rapport, relancer ne changera rien">` +
      `✅ Croisé avec source` +
      `<span class="mdv-cross-date">${status.date}</span>` +
      `</span>`;
  } else if (status) {
    // Already enriched — informational badge
    crossArea.innerHTML =
      `<span class="mdv-cross-badge" title="Ce rapport a été enrichi par croisement avec le document source via chorus-complete-report">` +
      `✅ Croisé avec source` +
      `<span class="mdv-cross-date">${status.date}</span>` +
      `</span>`;
  } else {
    // Not yet enriched — button to launch the cross-check
    crossArea.innerHTML =
      `<button class="btn btn-ghost btn-sm" onclick="openMdvCrossCheckTerminal()" ` +
      `title="Croiser les éléments incertains (❓) de ce rapport avec le document source original — chorus-complete-report">` +
      `🔀 Cross-check source</button>`;
  }
}

/**
 * Detects whether an explain-*.md report has already been processed by
 * chorus-complete-report (Phase C4, or its "zero-target guard") from its
 * raw text content. Returns `{ kind, date }` if found, otherwise `null`:
 *   - `kind: 'checked'` — at least one element was actually cross-checked
 *     (one of the 5 classifications ✅ 🛠️ ❓ 🏷️ ⚖️, see chorus-complete-report.md
 *     § Phase C3 Step 4).
 *   - `kind: 'nothing'` — the skill ran but found no ❓ uncertain /
 *     `_a_confirmer` elements to cross-check (zero-target guard, § Phase C1)
 *     — re-running the skill on this report will produce nothing different
 *     as long as no new uncertain elements appear.
 *
 * Recognises the current blockquote format:
 *   > 🔎 **Vérification croisée** (`chorus-complete-report`, YYYY-MM-DD) — <emoji> <label>
 * and the old bold format (backward compat — reports produced before the
 * skill's formatting change, Phase C4):
 *   **<emoji> Vérification croisée (chorus-complete-report, YYYY-MM-DD) :**
 *
 * Shared by updateMdvCrossArea() (simple Markdown viewer, 👁️) and
 * openReportView() (report-view modal / filterable table, 📝 Complete button)
 * — without this factorisation, the two display points of the "cross-check
 * already done?" button diverged and could show contradictory states for
 * the same file.
 */
function detectCompleteReportDone(content) {
  if (!content) return null;
  const m = content.match(
    /(?:>\s*🔎\s*\*\*Vérification croisée\*\*\s*\(`?chorus-complete-report`?,\s*(\d{4}-\d{2}-\d{2})\)\s*—\s*(ℹ️|[✅🛠️❓🏷️⚖️])|\*\*(ℹ️|[✅🛠️❓🏷️⚖️])\s*Vérification croisée\s*\(chorus-complete-report,\s*(\d{4}-\d{2}-\d{2})\))/
  );
  if (!m) return null;
  const date  = m[1] || m[4];
  const emoji = m[2] || m[3];
  return { kind: emoji === 'ℹ️' ? 'nothing' : 'checked', date };
}

/**
 * Ouvre le terminal ECA pré-contextualisé et lance chorus-complete-report.
 * Extrait le slug timestamp (YYYYMMDD-HHMMSS) depuis le nom du fichier explain.
 */
function openMdvCrossCheckTerminal() {
  const ctx = _mdvCtx;
  if (!ctx) return;

  const { sbId, entityId, projId, filename } = ctx;
  // Slug timestamp : dernière occurrence de YYYYMMDD-HHMMSS avant .md
  const slug = (filename.match(/(\d{8}-\d{6})\.md$/) || [])[1] || null;

  // Resolve the synthese-*.md file linked to the same run (same slug) —
  // without this, the 'report' terminal would systematically show "⚠ absent"
  // for the synthesis even when it actually existed on disk: this function
  // never passed syntheseFile to openLevelTerminal(), only explainFile
  // (see the same resolution logic in openRvTerminal() above, reapplied
  // here for this distinct entry point — opened from the simple Markdown
  // viewer 👁️, not from the report-view modal).
  const proj = (PROJECTS[sbId] || []).find(p => p.id === projId);
  const matchRun = slug
    ? (proj?.reports || []).find(r => r.kind === 'run' && (r.label || '').includes(slug))
    : null;
  const syntheseFile = matchRun?.synthese_file || null;

  const cmd = slug
    ? `chorus-complete-report ${sbId} ${entityId} --slug ${slug}`
    : `chorus-complete-report ${sbId} ${entityId}`;

  closeMdView();

  openLevelTerminal('report', {
    sbId,
    entityId,
    projId,
    projName: projId,
    reportFile: slug ? `run-report-${slug}.json` : filename,
    explainFile: filename,
    syntheseFile,
  }, cmd);
}

// ─── AGENT KB ORG VIEWER ────────────────────────────────────────
// Displays the full real content of agent/chorus/<slug>.org (the
// "👁️ Details" button in the Agents tab) — same modal as the markdown
// viewer, with a lightweight org→markdown preprocessor for correct
// rendering via marked.js. The file is still served as-is by the backend —
// no data is reformulated, only the presentation syntax is adapted.
// Two pitfalls to handle, both related to org table indentation
// (tables in agent/chorus/*.org are indented under their heading,
// e.g. "  |-----+-----|"):
//   1. marked.js (GFM) requires a flush-left table — an indented table
//      is simply not recognised as a table (rendered as plain text with
//      visible pipe characters, unreadable).
//   2. org marks column intersections on the separator row with "+"
//      ("|-----+------+-----|" — NO internal "|", only at the two ends).
//      Markdown requires a "|" at EVERY intersection ("|-----|------|-----|").
//      The "+" org characters must therefore be converted to "|" markdown
//      — not to "-" (which would merge all columns into one giant cell,
//      equally unreadable).
function orgToMarkdownLite(text) {
  const lines = text.split('\n').map(line => {
    const trimmed = line.trim();
    if (!/^\|.*\|$/.test(trimmed)) return line;
    // Table row (data or separator) — always un-indented for marked.
    // If it is a separator row (only -/+/:/spaces between the bars),
    // convert org "+" (intersections) to markdown "|".
    if (/^\|[\-+:\s]+\|$/.test(trimmed)) return trimmed.replace(/\+/g, '|');
    return trimmed;
  });
  return lines.join('\n')
    .replace(/^(\*+)(\s+)/gm, (m, stars) => '#'.repeat(stars.length) + ' ')
    .replace(/^#\+\w+:.*$/gm, '');
}

async function openAgentOrgView(slug) {
  if (!currentSandbox) return;
  const sbId = currentSandbox.id;
  _mdvCtx = null;  // pas un rapport explain — pas de cross-check
  const crossArea = document.getElementById('mdv-cross-area');
  if (crossArea) crossArea.innerHTML = '';
  document.getElementById('mdv-title').textContent = `${slug}.org`;
  document.getElementById('mdv-sub').textContent = `${sbId} / agent/chorus/${slug}.org`;
  document.getElementById('mdv-content').innerHTML = 'Chargement…';
  document.getElementById('md-view-overlay').hidden = false;

  try {
    const r = await fetch(`${API}/api/sandboxes/${sbId}/agents/${slug}/org`);
    if (!r.ok) throw new Error((await r.json().catch(()=>({error:r.statusText}))).error || r.statusText);
    const text = await r.text();
    document.getElementById('mdv-content').innerHTML =
      (typeof marked !== 'undefined') ? marked.parse(orgToMarkdownLite(text)) : `<pre>${text}</pre>`;
  } catch (e) {
    document.getElementById('mdv-content').innerHTML =
      `<div style="color:var(--error);font-size:12px">Impossible de charger ${slug}.org : ${e.message}</div>`;
  }
}

// ─── SANDBOX CORPUS MODAL ─────────────────────────────────────
// Reconnected to real KB data (agent/chorus/index.org + <slug>.org) via
// GET /api/sandboxes/:sbId/corpus — no more simulated data (SANDBOX_CORPUS
// is retained in the file but is no longer read by this function).
let _sbcCurrentTab = 'corpus';
let _sbcData = null;

async function openSandboxCorpus() {
  if (!currentSandbox) return;
  const sb = currentSandbox;
  const entities = ENTITIES[sb.id] || [];
  const projects = PROJECTS[sb.id] || [];
  const imported = projects.filter(p => p.state === 'imported').length;

  document.getElementById('sbc-title').textContent = `Corpus — ${sb.name}`;
  document.getElementById('sbc-subtitle').textContent = `${sb.standard} · ${sb.desc}`;
  document.getElementById('sbc-stats').innerHTML = '';
  document.getElementById('sbc-overview-content').innerHTML = 'Chargement…';
  document.getElementById('sbc-corpus-list').innerHTML = 'Chargement…';
  document.getElementById('sbc-agents-list').innerHTML = 'Chargement…';
  document.getElementById('sbc-frames-list').innerHTML = 'Chargement…';
  switchSbcTab('corpus');
  document.getElementById('sb-corpus-overlay').hidden = false;

  let data = null;
  try {
    const r = await fetch(`${API}/api/sandboxes/${sb.id}/corpus`);
    if (r.ok) ({ corpus: data } = await r.json());
  } catch { /* backend indisponible — géré par les messages vides ci-dessous */ }
  _sbcData = data;

  const pipeline          = data?.pipeline || [];
  const integratedCorpus  = data?.integratedCorpus || [];
  const corpusFilesAll    = data?.corpusFiles || [];
  const corpusFiles       = corpusFilesAll.filter(f => !f.isPreSplit);
  const corpusPreSplit    = corpusFilesAll.filter(f => f.isPreSplit);
  const readme            = data?.readme || null;
  const thesaurus         = data?.thesaurus || [];
  const totalFrames       = pipeline.reduce((s, a) => s + (a.frames?.length || 0), 0);
  const totalRules        = pipeline.reduce((s, a) => s + (a.ruleFileCount || 0), 0);

  // Stats bar — le compteur "Fichiers corpus" ne retient que les documents
  // real sources (excluding Phase 2 pre-split files, which are derived
  // excerpts of those same documents, not independent corpus elements).
  document.getElementById('sbc-stats').innerHTML = `
    <div class="cm-stat"><div class="cm-stat-val">${pipeline.length}</div><div class="cm-stat-key">Agents</div></div>
    <div class="cm-stat"><div class="cm-stat-val">${totalFrames}</div><div class="cm-stat-key">Frames</div></div>
    <div class="cm-stat"><div class="cm-stat-val">${totalRules}</div><div class="cm-stat-key">Règles YAML</div></div>
    <div class="cm-stat"><div class="cm-stat-val">${corpusFiles.length}</div><div class="cm-stat-key">Fichiers corpus</div></div>
    <div class="cm-stat"><div class="cm-stat-val">${entities.length}</div><div class="cm-stat-key">Entities</div></div>
    <div class="cm-stat"><div class="cm-stat-val">${imported}/${projects.length}</div><div class="cm-stat-key">Projets importés</div></div>
  `;

  // ── Overview panel: structural summary from README.org (no LLM) ─────────
  if (!readme && !pipeline.length) {
    document.getElementById('sbc-overview-content').innerHTML =
      '<div style="color:var(--text-muted);font-size:13px;padding:20px 0">Aucune KB trouvée pour ce sandbox (README.org et agent/chorus/index.org absents).</div>';
  } else {
    // ── rendering helpers ────────────────────────────────────────────────
    const hdr = (label) =>
      `<div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">${label}</div>`;

    // ── IDENTITY + PIPELINE ──────────────────────────────────────────────
    const identiteHtml = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px">
        <div>
          ${hdr('Identité')}
          <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:4px">${readme?.title || sb.name}</div>
          <div style="font-size:11px;color:var(--text-muted)">
            Statut : <strong style="color:var(--text-secondary)">${readme?.status || '?'}</strong>
            &nbsp;·&nbsp; Date init : ${readme?.date || '?'}
          </div>
        </div>
        <div>
          ${hdr('Pipeline — ' + pipeline.length + ' agent(s)')}
          ${pipeline.length
            ? `<div style="font-size:12px;color:var(--text-secondary);line-height:1.8">${
                pipeline.map(a => `<span style="font-family:'JetBrains Mono',monospace;font-size:11px">#${a.pos}</span>
                  <strong>${a.slug}</strong>
                  <span style="color:var(--text-muted)">${a.ruleFileCount ? '· ' + a.ruleFileCount + ' règles' : ''}</span><br>`).join('')
              }</div>`
            : '<div style="color:var(--text-muted);font-size:12px">Aucun agent.</div>'}
        </div>
      </div>`;

    // ── CORPUS COVERAGE ──────────────────────────────────────────────────
    const covEntries = readme?.coverageEntries || [];
    const nInt   = covEntries.filter(e => e.kind === 'integrated').length;
    const nDef   = covEntries.filter(e => e.kind === 'deferred').length;
    const nOos   = covEntries.filter(e => e.kind === 'out_of_scope').length;
    const nProm  = covEntries.filter(e => e.kind === 'promoted').length;
    // 'promoted': accent colour (neither permanently green like Integrated,
    // nor neutral grey like OOS) — signals a transient delta from the last
    // chorus-feed --enrich pass (sections that just moved from Deferred to
    // Integrated), not a permanent coverage category.
    const kindStyle = { integrated: 'color:var(--success)', deferred: 'color:var(--warn)', out_of_scope: 'color:var(--text-muted)', promoted: 'color:var(--accent)' };
    // Each Coverage row is expandable (native <tr> accordion, no extra
    // JS or modal): click → shows the detailed sub-table
    // (Corpus Section/Rule → Generated rules | Reason) extracted from the
    // README.org sous le heading **. Replié par défaut — layout inchangé
    // tant que l'utilisateur ne clique pas. Un badge "▸ N" indique le
    // nombre de lignes de détail disponibles ; pas de badge si aucun détail.
    const covTableHtml = covEntries.length
      ? `<div style="overflow-x:auto;margin-top:8px">
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <thead><tr style="border-bottom:1px solid var(--border)">
              <th style="text-align:left;padding:3px 8px;color:var(--text-muted);font-weight:600">Statut</th>
              <th style="text-align:left;padding:3px 8px;color:var(--text-muted);font-weight:600">Agent / Source</th>
              <th style="text-align:left;padding:3px 8px;color:var(--text-muted);font-weight:600">Détail</th>
              <th style="width:28px"></th>
            </tr></thead>
            <tbody>${covEntries.map((e, i) => {
              const hasDetail = e.detailRows && e.detailRows.length;
              const rowId = `cov-detail-${i}`;
              const toggle = hasDetail
                ? ` onclick="document.getElementById('${rowId}').classList.toggle('hidden');this.querySelector('.cov-chevron').classList.toggle('open')" style="cursor:pointer"`
                : '';
              const detailBlock = hasDetail
                ? `<tr id="${rowId}" class="hidden">
                    <td colspan="4" style="padding:4px 8px 10px 24px;background:var(--bg-surface)">
                      ${e.corpusRef ? `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;font-family:'JetBrains Mono',monospace">${e.corpusRef}</div>` : ''}
                      <table style="width:100%;border-collapse:collapse;font-size:10px">
                        ${e.detailHeaders ? `<thead><tr style="border-bottom:1px solid var(--border-light)">
                          ${e.detailHeaders.map(h => `<th style="text-align:left;padding:2px 6px;color:var(--text-muted);font-weight:600">${h}</th>`).join('')}
                        </tr></thead>` : ''}
                        <tbody>${e.detailRows.map(r => `
                          <tr style="border-bottom:1px solid var(--border-light)">
                            ${r.map(c => `<td style="padding:2px 6px;color:var(--text-secondary);vertical-align:top">${c}</td>`).join('')}
                          </tr>`).join('')}
                        </tbody>
                      </table>
                    </td>
                  </tr>`
                : '';
              return `
              <tr style="border-bottom:1px solid var(--border-light)"${toggle}>
                <td style="padding:3px 8px;white-space:nowrap;${kindStyle[e.kind]||''}">${e.status} ${e.kind === 'integrated' ? 'Integrated' : e.kind === 'deferred' ? 'Deferred' : e.kind === 'promoted' ? 'Promoted' : 'OOS'}</td>
                <td style="padding:3px 8px;color:var(--text-secondary);max-width:260px;word-break:break-word">${e.label || '—'}</td>
                <td style="padding:3px 8px;color:var(--text-muted);font-size:10px;font-family:'JetBrains Mono',monospace">${e.detail || ''}</td>
                <td style="padding:3px 8px;text-align:center;color:var(--text-muted);font-size:9px">${hasDetail ? `<span class="cov-chevron">▸</span> ${e.detailRows.length}` : ''}</td>
              </tr>${detailBlock}`;
            }).join('')}
            </tbody>
          </table>
        </div>`
      : '<div style="color:var(--text-muted);font-size:12px;margin-top:6px">Aucune entrée Coverage trouvée dans README.org.</div>';

    const coverageHtml = `
      <div style="margin-bottom:18px">
        ${hdr('Couverture corpus (README.org § Coverage)')}
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
          ${readme?.coverageLastUpdate
            ? `<span style="font-size:11px;color:var(--text-muted)">📅 MAJ : ${readme.coverageLastUpdate.slice(0, 80)}</span>`
            : ''}
          <span style="background:var(--success-dim);color:var(--success);border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600">✅ ${nInt} Integrated</span>
          ${nProm ? `<span style="background:var(--accent-dim);color:var(--accent);border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600">✅ ${nProm} Promoted (last pass)</span>` : ''}
          ${nDef ? `<span style="background:var(--warn-dim);color:var(--warn);border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600">⏭ ${nDef} Deferred</span>` : ''}
          ${nOos ? `<span style="background:var(--bg-elevated);color:var(--text-muted);border-radius:4px;padding:2px 8px;font-size:11px">⛔ ${nOos} OOS</span>` : ''}
        </div>
        ${covTableHtml}
      </div>`;

    // ── KB HEALTH — Agent status ─────────────────────────────────────────
    const agentStatus = readme?.agentStatusTable || [];
    const agentStatusHtml = agentStatus.length
      ? `<div style="overflow-x:auto;margin-top:8px">
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <thead><tr style="border-bottom:1px solid var(--border)">
              <th style="text-align:left;padding:3px 8px;color:var(--text-muted);font-weight:600">Agent</th>
              <th style="text-align:left;padding:3px 8px;color:var(--text-muted);font-weight:600">KB</th>
              <th style="text-align:left;padding:3px 8px;color:var(--text-muted);font-weight:600">YAML</th>
              <th style="text-align:left;padding:3px 8px;color:var(--text-muted);font-weight:600">Helpers</th>
              <th style="text-align:center;padding:3px 8px;color:var(--text-muted);font-weight:600">Enrichiss.</th>
            </tr></thead>
            <tbody>${agentStatus.map(a => `
              <tr style="border-bottom:1px solid var(--border-light)">
                <td style="padding:3px 8px;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--accent)">${a.agent}</td>
                <td style="padding:3px 8px;color:${a.kb === '✓' ? 'var(--success)' : 'var(--error)'};text-align:center">${a.kb}</td>
                <td style="padding:3px 8px;color:var(--text-secondary);font-size:10px">${a.yaml}</td>
                <td style="padding:3px 8px;color:var(--text-muted);font-size:10px">${a.helpers || '—'}</td>
                <td style="padding:3px 8px;text-align:center;font-family:'JetBrains Mono',monospace;font-weight:600;color:var(--info)">${a.enrichissements || '0'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`
      : '<div style="color:var(--text-muted);font-size:12px;margin-top:6px">Table * Agent status absente du README.org.</div>';

    const sbKbHtml = `
      <div style="margin-bottom:18px">
        ${hdr('Santé KB (README.org § Agent status)')}
        ${agentStatusHtml}
      </div>`;

    // ── SESSION — enrichissements + validation ────────────────────────────


    // Helper — renders an expandable detail table for a bug/gap section.
    // domId must be unique across the two categories (infra vs kbgaps).
    const _bugDetailBlock = (tbl, domId) => {
      if (!tbl?.rows?.length) return '';
      return `
        <div id="${domId}" class="hidden" style="margin-top:8px;overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:10px">
            ${tbl.headers?.length ? `<thead><tr style="border-bottom:1px solid var(--border-light)">
              ${tbl.headers.map(h => `<th style="text-align:left;padding:2px 6px;color:var(--text-muted);font-weight:600">${h}</th>`).join('')}
            </tr></thead>` : ''}
            <tbody>${tbl.rows.map(r => `
              <tr style="border-bottom:1px solid var(--border-light)">
                ${r.map(c => `<td style="padding:2px 6px;color:var(--text-secondary);vertical-align:top">${c}</td>`).join('')}
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    };

    // Type 1 — infrastructure bugs (YAML/Perl, found during chorus-check)
    const infraTbl   = readme?.infraBugsTable;
    const infraToggle = infraTbl?.rows?.length
      ? ` style="cursor:pointer" onclick="document.getElementById('kb-infra-bugs-detail').classList.toggle('hidden');this.querySelector('.cov-chevron').classList.toggle('open')"`
      : '';
    const infraHtml = (readme?.infraBugsFixed || 0) > 0
      ? `<span${infraToggle} title="${infraTbl ? 'Cliquer pour voir le détail' : 'Bugs Perl/YAML qui empêchaient le pipeline de tourner'}"
           style="font-size:12px;color:var(--text-secondary)${infraTbl ? ';cursor:pointer' : ''}">
           🔧 <strong>${readme.infraBugsFixed}</strong> bug${readme.infraBugsFixed > 1 ? 's' : ''} infrastructure
           <span style="font-size:10px;color:var(--text-muted)">(implémentation YAML/Perl)</span>
           ${infraTbl ? `<span class="cov-chevron">▸</span>` : ''}
         </span>`
      : '';

    // Type 2 — KB semantic gaps (found by chorus-strengthen / chorus-fix)
    const kbTbl    = readme?.kbGapsTable;
    const kbToggle = kbTbl?.rows?.length
      ? ` style="cursor:pointer" onclick="document.getElementById('kb-gaps-detail').classList.toggle('hidden');this.querySelector('.cov-chevron').classList.toggle('open')"`
      : '';
    const kbGapsHtml = (readme?.kbGapsFixed || 0) > 0
      ? `<span${kbToggle} title="${kbTbl ? 'Cliquer pour voir le détail' : 'Gaps sémantiques dans les règles YAML'}"
           style="font-size:12px;color:var(--text-secondary)${kbTbl ? ';cursor:pointer' : ''}">
           🎯 <strong>${readme.kbGapsFixed}</strong> gap${readme.kbGapsFixed > 1 ? 's' : ''} KB résolus
           <span style="font-size:10px;color:var(--text-muted)">(strengthen / fix)</span>
           ${kbTbl ? `<span class="cov-chevron">▸</span>` : ''}
         </span>`
      : '';

    const sessionHtml = `
      <div>
        ${hdr('Session (README.org § Session notes)')}
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          ${readme?.enrichmentCount
            ? `<span style="font-size:12px;color:var(--text-secondary)">📝 <strong>${readme.enrichmentCount}</strong> enrichissement(s)
               ${readme.enrichmentLastDate ? `<span style="color:var(--text-muted)">· dernier : ${readme.enrichmentLastDate}</span>` : ''}</span>`
            : ''}
          ${infraHtml}
          ${kbGapsHtml}
        </div>
        ${_bugDetailBlock(infraTbl, 'kb-infra-bugs-detail')}
        ${_bugDetailBlock(kbTbl,   'kb-gaps-detail')}
      </div>`;

    document.getElementById('sbc-overview-content').innerHTML =
      identiteHtml + coverageHtml + sbKbHtml + sessionHtml;
  }

  // ── Panel Corpus : fichiers sources + mapping vers les agents ──────────
  if (!data) {
    document.getElementById('sbc-corpus-list').innerHTML =
      '<div style="color:var(--text-muted);font-size:13px;padding:20px 0">Backend indisponible ou aucune KB trouvée (agent/chorus/index.org absent) pour ce sandbox.</div>';
  } else if (!corpusFilesAll.length) {
    document.getElementById('sbc-corpus-list').innerHTML =
      '<div style="color:var(--text-muted);font-size:13px;padding:20px 0">Aucun fichier dans corpus/.</div>';
  } else {
    const fileToAgents = {};
    integratedCorpus.forEach(r => { fileToAgents[(r.file || '').replace(/^corpus\//, '')] = r.agents; });
    const renderFileRow = f => {
      const agents = fileToAgents[f.name];
      const sizeKb = f.size != null ? `${Math.round(f.size / 1024)} Ko` : '?';
      const meta = [f.date, f.version].filter(Boolean);
      return `
        <div class="corpus-node" style="margin-bottom:4px;align-items:flex-start">
          <span class="cn-key" style="min-width:280px;max-width:280px;white-space:normal;word-break:break-all">${f.name}</span>
          <span style="font-size:10px;color:var(--text-muted);min-width:55px;flex-shrink:0">${sizeKb}</span>
          <span style="flex:1;font-size:11px;color:${agents ? 'var(--text-secondary)' : 'var(--text-muted)'}">
            ${f.source ? `<div>${f.source}</div>` : ''}
            ${agents ? `<div style="color:var(--text-muted);margin-top:1px">→ ${agents}</div>` : '<div style="color:var(--text-muted);margin-top:1px">(non référencé dans index.org)</div>'}
            ${meta.length ? `<div style="color:var(--accent);margin-top:1px;font-size:10px">${meta.map(m=>`📅 ${m}`).join(' · ')}</div>` : ''}
          </span>
        </div>`;
    };
    document.getElementById('sbc-corpus-list').innerHTML = `
      <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px">
        Documents sources (${corpusFiles.length}) — mapping vers les agents, version/date (README.org, CORPUS-DIRECTIVES.md)
      </div>
      ${corpusFiles.length ? corpusFiles.map(renderFileRow).join('') : '<div style="color:var(--text-muted);font-size:12px">Aucun document source identifié.</div>'}
      ${corpusPreSplit.length ? `
        <details style="margin-top:16px">
          <summary style="cursor:pointer;font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em">
            Fichiers dérivés — pré-split agent, Phase 2 (${corpusPreSplit.length}, non comptés comme éléments de corpus)
          </summary>
          <div style="margin-top:8px">${corpusPreSplit.map(renderFileRow).join('')}</div>
        </details>` : ''}
    `;
  }

  // ── Panel Agents : vue légère, une carte par agent ──────────────────────
  if (!data || !pipeline.length) {
    document.getElementById('sbc-agents-list').innerHTML =
      '<div style="color:var(--text-muted);font-size:13px;padding:20px 0">Aucun agent/pipeline trouvé pour ce sandbox (agent/chorus/index.org absent ou vide).</div>';
  } else {
    document.getElementById('sbc-agents-list').innerHTML = pipeline.map(ag => `
      <div class="sbc-agent-card">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span class="mono" style="font-size:11px;color:var(--accent);font-weight:700">#${ag.pos}</span>
          <span style="font-size:13px;font-weight:600;color:var(--text-primary)">${ag.slug}</span>
        </div>
        <div class="mono" style="font-size:10px;color:var(--text-muted);margin-bottom:6px">${ag.module}</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px">${ag.status || ''}</div>
        ${ag.corpusFile ? `<div style="font-size:10px;color:var(--text-muted);font-family:'JetBrains Mono',monospace;margin-bottom:6px">📄 ${ag.corpusFile}</div>` : ''}
        <div style="display:flex;align-items:center;gap:10px;font-size:11px;color:var(--text-secondary)">
          <span>🧩 ${(ag.frames||[]).length} frame${(ag.frames||[]).length!==1?'s':''}</span>
          <span>📜 ${ag.ruleFileCount} règle${ag.ruleFileCount!==1?'s':''}</span>
          <span style="flex:1"></span>
          <button class="btn btn-ghost btn-sm" style="padding:2px 9px;font-size:10px" title="Voir ${ag.slug}.org (KB agent)" onclick="openAgentOrgView('${ag.slug}')">👁️ Détails</button>
        </div>
      </div>
    `).join('');
  }

  // ── Panel Pipeline & KB : par agent — domaine, Frame catalogue, règles ──
  if (!data || !pipeline.length) {
    document.getElementById('sbc-frames-list').innerHTML =
      '<div style="color:var(--text-muted);font-size:13px;padding:20px 0">Aucun agent/pipeline trouvé pour ce sandbox (agent/chorus/index.org absent ou vide).</div>';
  } else {
    document.getElementById('sbc-frames-list').innerHTML = pipeline.map(ag => `
      <div style="border:1px solid var(--border);border-radius:8px;margin-bottom:14px;overflow:hidden">
        <div style="background:var(--bg-elevated);padding:10px 14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span class="mono" style="font-size:11px;color:var(--accent);font-weight:700">#${ag.pos}</span>
          <span style="font-size:13px;font-weight:600;color:var(--text-primary)">${ag.slug}</span>
          <span class="mono" style="font-size:10px;color:var(--text-muted)">${ag.module}</span>
          <span style="flex:1"></span>
          <span style="font-size:10px;color:var(--text-muted)">${ag.status || ''}</span>
        </div>
        <div style="padding:12px 14px">
          ${ag.corpusFile ? `<div style="font-size:11px;color:var(--text-muted);font-family:'JetBrains Mono',monospace;margin-bottom:8px">📄 ${ag.corpusFile}</div>` : ''}
          ${ag.domain ? `<div style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin-bottom:12px;white-space:pre-line">${ag.domain}</div>` : ''}
          ${(ag.frames || []).map(f => `
            <div style="background:var(--bg-surface);border:1px solid var(--border-light);border-radius:6px;padding:8px 12px;margin-bottom:8px">
              <div class="mono" style="font-size:12px;color:var(--accent);font-weight:600;margin-bottom:4px">Frame: ${f.name}</div>
              ${f.inputs.length ? `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:2px"><strong>Slots d'entrée :</strong> ${f.inputs.join(', ')}</div>` : ''}
              ${f.computed.length ? `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:2px"><strong>Slots calculés :</strong> ${f.computed.join(', ')}</div>` : ''}
              ${f.optional.length ? `<div style="font-size:11px;color:var(--text-muted)"><strong>Optionnels :</strong> ${f.optional.join(', ')}</div>` : ''}
            </div>
          `).join('')}
          <div style="font-size:11px;color:var(--text-muted);margin:10px 0 6px">📜 ${ag.ruleFileCount} règle(s) YAML — rules/${ag.slug}/</div>
          ${(ag.rules || []).map(r => `
            <div style="padding:6px 0;border-top:1px solid var(--border-light)">
              <span class="mono" style="font-size:11px;color:var(--accent)">${r.id}</span>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${r.intent || ''}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');
  }

  // ── Thesaurus panel — removed from the sandbox-level Corpus modal (the
  // info is now available, filtered by project, in the "Thesaurus" tab of
  // the Project view — see renderPvThesaurusTab()). `thesaurus` is still
  // loaded in `data` (used by renderPvThesaurusTab via the same endpoint
  // /api/sandboxes/:sbId/corpus) but is no longer rendered here.
}

function closeSandboxCorpus() {
  document.getElementById('sb-corpus-overlay').hidden = true;
}

function switchSbcTab(tab) {
  _sbcCurrentTab = tab;
  ['overview', 'corpus', 'agents', 'frames'].forEach(t => {
    const btn   = document.getElementById(`sbc-tab-${t}`);
    const panel = document.getElementById(`sbc-panel-${t}`);
    const active = t === tab;
    if (btn)   { btn.style.borderBottomColor = active ? 'var(--accent)' : 'transparent'; btn.classList.toggle('active', active); }
    if (panel) panel.style.display = active ? '' : 'none';
  });
}

// ─── CORPUS MODAL ─────────────────────────────────────────────
let corpusFilter = 'all';
let _corpusProj = null;

function openCorpusModal(projId) {
  const sbId = currentSandbox ? currentSandbox.id : null;
  const proj = (PROJECTS[sbId]||[]).find(p=>p.id===projId);
  if (!proj) return;
  corpusFilter = 'all';
  _corpusProj = proj;

  document.getElementById('cm-proj-name').textContent = proj.name;
  const ctx = (ENTITIES[sbId]||[]).find(c=>c.id===proj.entity)||(ENTITIES[sbId]||[])[0];
  const ctxPath = ctx ? `$workspace/${sbId}/${ctx.path}/project-${projId}.json` : `$workspace/${sbId}/.../project-${projId}.json`;
  document.getElementById('cm-proj-path').textContent = ctxPath;

  renderCorpusModal(proj);
  document.getElementById('corpus-modal-overlay').hidden = false;
}

function renderCorpusModal(proj) {
  const frames = proj.corpus || [];
  const total = proj.frames || frames.length;
  const evidence = proj.evidence || 0;

  // Stats bar
  const resolved = frames.filter(f=>f.status==='resolved').length;
  const pending = frames.filter(f=>f.status==='pending').length;
  const unresolved = frames.filter(f=>f.status==='unresolved').length;
  document.getElementById('cm-stats').innerHTML = `
    <div class="cm-stat"><span class="cm-stat-val">${total}</span> frames</div>
    <div class="cm-stat"><span class="cm-stat-val" style="color:var(--success)">${resolved}</span> résolus</div>
    <div class="cm-stat"><span class="cm-stat-val" style="color:var(--warn)">${pending}</span> en attente</div>
    <div class="cm-stat"><span class="cm-stat-val" style="color:var(--error)">${unresolved}</span> non conformes</div>
    <div class="cm-stat"><span class="cm-stat-val">${evidence}</span> evidence</div>
  `;

  // Filter bar
  document.getElementById('cm-filter-bar').innerHTML = `
    <button class="cm-filter-btn ${corpusFilter==='all'?'active':''}" onclick="setCorpusFilter('all',this)">Tous (${frames.length||total})</button>
    ${resolved?`<button class="cm-filter-btn ${corpusFilter==='resolved'?'active':''}" onclick="setCorpusFilter('resolved',this)">✓ Résolus (${resolved})</button>`:''}
    ${pending?`<button class="cm-filter-btn ${corpusFilter==='pending'?'active':''}" onclick="setCorpusFilter('pending',this)">⏳ En attente (${pending})</button>`:''}
    ${unresolved?`<button class="cm-filter-btn ${corpusFilter==='unresolved'?'active':''}" onclick="setCorpusFilter('unresolved',this)">✗ Non conformes (${unresolved})</button>`:''}
  `;

  const body = document.getElementById('cm-body');

  if (frames.length === 0) {
    // Generic placeholder frames
    let ph = `<div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">${total} frames indexés — données détaillées non disponibles dans ce PoC.</div>`;
    for (let i=1; i<=Math.min(total,8); i++) {
      ph += `<div class="cm-placeholder-frame">
        <div class="cm-placeholder-line" style="width:${40+Math.floor(Math.random()*30)}%"></div>
        <div class="cm-placeholder-line" style="width:${60+Math.floor(Math.random()*30)}%;height:7px;opacity:.5"></div>
      </div>`;
    }
    if (total > 8) ph += `<div style="text-align:center;font-size:11px;color:var(--text-muted);padding:8px">… et ${total-8} frames supplémentaires</div>`;
    body.innerHTML = ph;
    return;
  }

  const visible = corpusFilter==='all' ? frames : frames.filter(f=>f.status===corpusFilter);
  body.innerHTML = visible.map(f=>`
    <div class="cm-frame">
      <div class="cm-frame-header">
        <span class="cm-frame-id">${f.id}</span>
        ${f.section?`<span class="cm-frame-section">§ ${f.section}</span>`:''}
        <span class="cm-frame-status ${f.status}">${f.status==='resolved'?'✓ RÉSOLU':f.status==='pending'?'⏳ EN ATTENTE':'✗ NON CONFORME'}</span>
      </div>
      <div class="cm-frame-text">${f.text}</div>
      ${f.tags&&f.tags.length?`<div class="cm-frame-tags">${f.tags.map(t=>`<span class="cm-frame-tag">${t}</span>`).join('')}</div>`:''}
      ${f.evidence?`<div class="cm-frame-ev">📎 ${f.evidence} pièce${f.evidence>1?'s':''} jointe${f.evidence>1?'s':''}</div>`:''}
    </div>
  `).join('') || `<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px">Aucun frame pour ce filtre.</div>`;
}

function setCorpusFilter(filter, btn) {
  corpusFilter = filter;
  document.querySelectorAll('.cm-filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderCorpusModal(_corpusProj);
}

function closeCorpusModal() {
  document.getElementById('corpus-modal-overlay').hidden = true;
}

function openImportModal(reimportProjId) {
  const modal = document.getElementById('modal-overlay');
  modal.hidden = false;

  const nameGroup      = document.getElementById('import-name-group');
  const nameLabel      = document.getElementById('import-name-label');
  const sourceGroup    = document.getElementById('import-source-group');
  const pathGroup      = document.getElementById('import-path-group');
  const contextGroup   = document.getElementById('import-context-group');

  if (reimportProjId) {
    // Replace mode — the existing project is overwritten in place.
    // No new name, no new entity, no new source file: just confirm and go.
    const sbId = currentSandbox ? currentSandbox.id : null;
    const proj = (PROJECTS[sbId]||[]).find(p=>p.id===reimportProjId);
    modal.dataset.reimportId      = reimportProjId;
    modal.dataset.reimportEntity  = proj ? proj.entity : '';
    modal.dataset.reimportReplace = 'true';

    const titleEl = modal.querySelector('h2');
    if (titleEl) titleEl.textContent = 'Ré-importer — remplacer le projet';

    // Hide all form fields (no user input required)
    nameGroup.hidden    = true;
    sourceGroup.hidden  = true;
    pathGroup.hidden    = true;
    contextGroup.hidden = true;

    // Confirmation block (created once, reused on subsequent calls)
    let infoEl = document.getElementById('reimport-replace-info');
    if (!infoEl) {
      infoEl = document.createElement('div');
      infoEl.id = 'reimport-replace-info';
      nameGroup.parentNode.insertBefore(infoEl, nameGroup);
    }
    infoEl.hidden = false;
    const srcFile  = proj ? (proj.sourceFile || proj.sourcePath || proj.path || '') : '';
    const srcLabel = (proj?.sourceBasename && proj.sourceBasename + (srcFile.match(/\.[^./]+$/) || [''])[0])
                   || srcFile.split('/').pop()
                   || '(source inconnue)';
    infoEl.innerHTML = `
      <div style="padding:14px;background:var(--bg-elevated);border:1px solid var(--border);
                  border-radius:8px">
        <div style="font-size:13px;color:var(--text-primary);margin-bottom:10px">
          Le projet <strong>${escapeHtml(proj?.name || reimportProjId)}</strong>
          sera <strong>remplacé</strong> par un ré-import depuis la même source.
        </div>
        <div style="font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px">
          <div>📄 Source : <code>${escapeHtml(srcLabel)}</code></div>
          <div>🏢 Entity : <code>${escapeHtml(proj?.entity || '—')}</code></div>
          <div style="color:var(--text-muted);margin-top:6px;font-size:10.5px">
            ℹ️ Le fichier <code>${escapeHtml(reimportProjId)}.json</code> sera écrasé.
            Les rapports existants restent disponibles jusqu'au prochain chorus-check.
          </div>
        </div>
      </div>`;

    // Freeze source fields for startImport() compat (never displayed)
    document.getElementById('import-source').value = proj ? (proj.type || 'pdf') : 'pdf';
    document.getElementById('import-path').value   = srcFile;

    // No user input → button enabled immediately
    validateImportName();
  } else {
    delete modal.dataset.reimportId;
    delete modal.dataset.reimportEntity;
    delete modal.dataset.reimportReplace;
    const infoEl = document.getElementById('reimport-replace-info');
    if (infoEl) infoEl.hidden = true;
    const titleEl = modal.querySelector('h2');
    if (titleEl) titleEl.textContent = 'Importer un projet';

    nameLabel.textContent = 'Project name';
    sourceGroup.hidden    = false;
    pathGroup.hidden      = false;
    contextGroup.hidden   = false;

    document.getElementById('import-name').value = '';
    const fileInputReset = document.getElementById('import-file');
    if (fileInputReset) fileInputReset.value = '';
    updateImportFileHint();

    // Normal import flow: no specific name constraint (the slug is
    // computed/validated only on re-import) — empty hint, button active.
    const hintEl = document.getElementById('import-name-hint');
    if (hintEl) hintEl.textContent = '';
    const btnEl = document.getElementById('import-start-btn');
    if (btnEl) { btnEl.disabled = false; btnEl.title = ''; }
  }

  // Populate context dropdown for current sandbox — pre-selects the
  // currently scoped entity if there is one (currentEntityId), otherwise
  // leaves the dropdown on its first option (no scope selected — the
  // button is now visible as soon as the sandbox has at least one entity,
  // scoped or not, see renderProjectsTab() § import-project-btn-wrap).
  // Unnecessary on re-import (group hidden) but the internal value is kept
  // for startImport() compat.
  const entitySel = document.getElementById('import-context');
  const entities = currentSandbox ? (ENTITIES[currentSandbox.id] || []) : [];
  const preselectId = reimportProjId
    ? ((PROJECTS[currentSandbox?.id]||[]).find(p=>p.id===reimportProjId)?.entity)
    : currentEntityId;
  entitySel.innerHTML = entities.map(c =>
    `<option value="${c.id}"${c.id === preselectId ? ' selected' : ''}>${c.label} — ${c.path}</option>`
  ).join('');
  if (!entities.length) {
    // Aucun niveau 'default' : pas d'entity ⇒ pas d'option sélectionnable,
    // the user must create an entity before they can import.
    entitySel.innerHTML = '<option value="">— aucune entity, créez-en une —</option>';
  }
}

function closeModal() {
  document.getElementById('modal-overlay').hidden = true;
}

function quickImport(projId) {
  if (!currentSandbox) return;
  const proj = (PROJECTS[currentSandbox.id] || []).find(p => p.id === projId);
  if (!proj) return;
  proj.state = 'importing';
  proj.progress = 5;
  renderProjectsTab();

  // Simulate import progress
  const interval = setInterval(() => {
    proj.progress = Math.min(proj.progress + Math.random() * 12 + 3, 99);
    renderProjectsTab();
    if (proj.progress >= 99) {
      clearInterval(interval);
      setTimeout(() => {
        proj.state = 'imported';
        proj.frames = Math.floor(Math.random() * 20) + 15;
        proj.evidence = Math.floor(Math.random() * 8) + 5;
        proj.compliance = Math.floor(Math.random() * 20) + 75;
        proj.lastRun = new Date().toISOString().slice(0, 10);
        renderProjectsTab();
        renderGlobalDashboard();
        renderSidebar();
      }, 800);
    }
  }, 600);
}

// ─── Project name validation (re-import mode) ─────────────────
// Rules required on the re-import panel:
//  1. Name cannot be empty.
//  2. Name must differ from the original project (otherwise silent
//     ambiguity server-side — cf. scanEntity which indexes by slug).
//  3. The derived slug (project-<slug>.json convention, the only one
//     recognised by chorus.js § scanEntity) must not collide with an
//     already existing project in this sandbox.
//  4. The slug must not be empty after normalisation (e.g. a name made
//     up entirely of special characters) — otherwise the produced file
//     would be named "project-.json", invalid/unambiguous and must be
//     fixed before even launching the import.
// Returns { ok: true, slug, id } or { ok: false, reason }.
function computeReimportSlug(newName, sbId, existingProj) {
  const trimmed = (newName || '').trim();
  if (!trimmed) return { ok: false, reason: 'Le nom du nouveau projet est obligatoire.' };
  if (existingProj && trimmed === existingProj.name) {
    return { ok: false, reason: 'Le nouveau projet doit porter un nom différent du projet d\'origine.' };
  }
  let slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  // Le nom affiché provient souvent du slug de fichier d'origine dérivé via
  // scanFlatProject() (ex: "Projet Import Cbom 005 KAFKA", cf. chorus.js —
  // slug.replace(/[-_]/g,' ').replace(/\b\w/g, toUpperCase)), qui porte déjà
  // the prefix "Projet "/"Project ". Without removal, we would get a doubled
  // id "project-projet-...json" once prefixed below. This prefix is only
  // stripped once, at the head of the slug.
  slug = slug.replace(/^(projet|project)-/, '');
  if (!slug) {
    return { ok: false, reason: 'Ce nom ne produit aucun identifiant de fichier valide — utilisez au moins une lettre ou un chiffre.' };
  }
  const id = `project-${slug}`;
  if ((PROJECTS[sbId]||[]).some(p => p.id === id)) {
    return { ok: false, reason: `Un projet nommé "${trimmed}" existe déjà dans ce sandbox — choisissez un autre nom.` };
  }
  return { ok: true, slug, id };
}

// Infers the import-source <select> value from a File's extension — keeps
// the (now auto-derived, no longer user-facing) field consistent with
// whatever file the user actually picked, without requiring a manual
// selection in sync with the file picker.
function inferImportSourceFromFilename(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx' || ext === 'csv') return 'xlsx';
  if (ext === 'md' || ext === 'txt') return 'md';
  if (ext === 'json') return 'json';
  return 'pdf';
}

// Called on file picker change — updates the inline hint (filename + size)
// and keeps import-source in sync (see inferImportSourceFromFilename above).
// Mirrors the live-validation pattern of validateImportName() below.
function updateImportFileHint() {
  const input = document.getElementById('import-file');
  const hint  = document.getElementById('import-file-hint');
  const sourceSel = document.getElementById('import-source');
  if (!input || !hint) return;
  const file = input.files && input.files[0];
  if (!file) {
    hint.textContent = 'Aucun fichier sélectionné';
    hint.style.color = 'var(--text-muted)';
    return;
  }
  const sizeKb = Math.round(file.size / 1024);
  hint.textContent = `✓ ${file.name} (${sizeKb} Ko)`;
  hint.style.color = 'var(--success, #10B981)';
  if (sourceSel) sourceSel.value = inferImportSourceFromFilename(file.name);
}

// Live validation (called on every keystroke + at modal open in re-import
// mode): disables "Start import" and shows the error inline as long as the
// entered name is not compatible with the server convention — prevents a
// re-import from "succeeding" on the UI side while producing a file never
// detected by the scan (cf. incident sandbox 08 / entity Apache,
// import-<ts>.json file invisible — root cause documented in the previous
// fix session).
function validateImportName() {
  const modal = document.getElementById('modal-overlay');
  const reimportId = modal.dataset.reimportId || null;
  const btn  = document.getElementById('import-start-btn');
  const hint = document.getElementById('import-name-hint');
  if (!btn || !hint) return;

  // Replace mode — no name field, button always enabled
  if (modal.dataset.reimportReplace === 'true') {
    btn.disabled = false; btn.title = ''; hint.textContent = ''; return;
  }

  if (!reimportId) { btn.disabled = false; btn.title = ''; hint.textContent = ''; return; }
  if (!currentSandbox) return;

  const sbId = currentSandbox.id;
  const existingProj = (PROJECTS[sbId]||[]).find(p=>p.id===reimportId);
  const newName = document.getElementById('import-name').value;
  const result = computeReimportSlug(newName, sbId, existingProj);

  if (result.ok) {
    btn.disabled = false;
    btn.title = '';
    hint.style.color = 'var(--success, #10B981)';
    hint.textContent = `✓ → ${result.id}.json`;
  } else {
    btn.disabled = true;
    btn.title = result.reason;
    hint.style.color = 'var(--error, #EF4444)';
    hint.textContent = `✗ ${result.reason}`;
  }
}

function startImport() {
  const modal = document.getElementById('modal-overlay');
  const reimportId = modal.dataset.reimportId || null;

  // Re-import mode: replace the existing project in place (same JSON file,
  // same entity, same source — content is overwritten by chorus-import-project).
  if (reimportId) {
    if (!currentSandbox) return;
    const sbId = currentSandbox.id;
    const existingProj = (PROJECTS[sbId]||[]).find(p=>p.id===reimportId);
    if (!existingProj) return;

    closeModal();

    const entityId   = modal.dataset.reimportEntity || existingProj.entity;
    const sourceFile = existingProj.sourceFile || existingProj.sourcePath || existingProj.path || '';
    // --out points to the SAME file → overwrites the existing project JSON.
    // Resolved as workspace/<entityId>/<existingProj.id>.json (the flat
    // convention recognised by scanEntity, cf. scanner.js § scanFlatProject).
    const outFile = `workspace/${entityId}/${existingProj.id}.json`;

    // Mark existing project as "re-importing" in place — no new entry.
    existingProj.state    = 'importing';
    existingProj.progress = 2;
    renderProjectsTab();

    const cmd = `chorus-import-project ${sbId} ${sourceFile} --context ${entityId} --out ${outFile}\n`
      + `ℹ️ REMPLACEMENT de "${existingProj.name}" — source et entity inchangées.\n`
      + `⚠️ Ne pas redemander la source : réutilise le document ci-dessus.\n`
      + `✅ Écrire dans ${outFile} (écrase le fichier existant).`;

    openLevelTerminal('project', {
      sbId,
      entityId,
      projId:   existingProj.id,
      projName: existingProj.name,
    }, cmd);
    return;
  }

  const name = document.getElementById('import-name').value.trim();
  const fileInput = document.getElementById('import-file');
  const file = fileInput && fileInput.files && fileInput.files[0];
  const source = document.getElementById('import-source').value;
  const context = document.getElementById('import-context').value;
  if (!name) {
    document.getElementById('import-name').focus();
    return;
  }
  if (!file) {
    fileInput.focus();
    alert('Sélectionnez un fichier à importer.');
    return;
  }
  if (!context) {
    document.getElementById('import-context').focus();
    return;
  }
  closeModal();
  if (!currentSandbox) return;

  const id = 'import-' + Date.now();
  const newProj = {
    id, name,
    type: source,
    entity: context,
    frames: 0, evidence: 0,
    state: 'importing',
    progress: 2,
    imports: [],
    reports: [],
  };
  const sbId = currentSandbox.id;
  PROJECTS[sbId] = PROJECTS[sbId] || [];
  PROJECTS[sbId].push(newProj);
  renderProjectsTab();

  // Unified with the re-import flow (startImport() § reimportId branch
  // above): upload the file server-side first (no ECA session triggered
  // by the upload itself — see server/routes/projects.js §
  // '/projects/upload'), then open a precontextualised, real interactive
  // ECA terminal running the actual chorus-import-project command —
  // instead of the former custom "ISP" preview panel (openImportSession()
  // / #import-session-overlay), which ran a real headless session behind
  // the scenes but was mislabelled "APERÇU SIMULÉ" in its own UI and gave
  // no genuine interactive terminal access, unlike re-import.
  const form = new FormData();
  form.append('file', file);
  form.append('projId', id);

  fetch(`${API}/api/sandboxes/${sbId}/entities/${context}/projects/upload`, {
    method: 'POST', body: form,
  })
    .then(async (r) => {
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      return r.json();
    })
    .then(({ path: destFile, outFile }) => {
      newProj.sourceFile = destFile;

      const cmd = `chorus-import-project ${sbId} ${destFile} --context ${context} --out ${outFile}`;

      openLevelTerminal('project', {
        sbId,
        entityId: context,
        projId:   id,
        projName: name,
      }, cmd);
    })
    .catch((err) => {
      newProj.state = 'error';
      renderProjectsTab();
      alert(`Échec de l'upload du fichier source : ${err.message}`);
    });
}

function openNewSandboxModal() {
  document.getElementById('newsb-name').value = '';
  document.getElementById('newsb-standard').value = '';
  document.getElementById('newsb-ctx-name').value = '';
  document.getElementById('newsb-icon').value = '📋';
  document.getElementById('newsb-model').value = 'opus';
  document.getElementById('newsb-entity-path-preview').textContent = '';
  document.getElementById('newsb-modal-overlay').hidden = false;
  document.getElementById('newsb-name').focus();
}

function closeNewSbModal() {
  document.getElementById('newsb-modal-overlay').hidden = true;
}

// Live-preview context path slug as user types
(function() {
  function setup() {
    const ctxInput = document.getElementById('newsb-ctx-name');
    if (!ctxInput) return;
    ctxInput.addEventListener('input', function() {
      const slug = this.value.trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || '…';
      document.getElementById('newsb-entity-path-preview').textContent = slug;
    });
    document.getElementById('newsb-modal-overlay').addEventListener('click', function(e) {
      if (e.target === this) closeNewSbModal();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();

function createSandbox() {
  const name     = document.getElementById('newsb-name').value.trim();
  const standard = document.getElementById('newsb-standard').value.trim();
  const icon     = document.getElementById('newsb-icon').value;
  const entityName  = document.getElementById('newsb-ctx-name').value.trim();
  const model    = document.getElementById('newsb-model').value;

  if (!name) { document.getElementById('newsb-name').focus(); return; }
  if (!entityName) { document.getElementById('newsb-ctx-name').focus(); return; }

  // Generate IDs
  const sbId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16)
               + '-' + Math.random().toString(36).slice(2, 5);
  // Aucun niveau 'default' : l'entity est obligatoire et dérivée du nom saisi.
  const entityId   = entityName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const ctxPath = 'workspace/' + entityId;
  const entityLabel = entityName;

  // Choose a color based on icon
  const iconColors = { '🔐': '#3B82F6', '📜': '#8B5CF6', '🏗️': '#F59E0B', '♿': '#10B981',
                        '🏥': '#EC4899', '☁️': '#06B6D4', '⚖️': '#6366F1', '🌍': '#22C55E', '📋': '#64748B' };

  // Register in SANDBOXES
  const sb = {
    id: sbId, name, icon,
    color: iconColors[icon] || '#64748B',
    desc: standard || 'Nouveau sandbox',
    standard: standard || '—',
    model,
    projects_total: 0, projects_imported: 0, runs: 0, last_run: null,
  };
  SANDBOXES.push(sb);

  // Register entities and projects (empty)
  ENTITIES[sbId] = [{ id: entityId, label: entityLabel, path: ctxPath }];
  PROJECTS[sbId] = [];

  closeNewSbModal();

  // Re-render sidebar + global page, then select the new sandbox
  renderSidebar();
  renderGlobalDashboard();
  selectSandbox(sbId);
}

// ─── NEW ENTITY MODAL ──────────────────────────────────────────
// Unlike createSandbox() above (still fully client-side/in-memory —
// out of scope here), entity creation is wired to a real backend route:
// POST /api/sandboxes/:sbId/entities materialises workspace/<entity>/
// with its two empty sources/ and reports/ subfolders on disk
// (server/routes/scan.js). No simulation — the request can fail (name
// collision, invalid sandbox) and the UI must reflect that.
function openNewEntityModal() {
  if (!currentSandbox) return;
  document.getElementById('newentity-name').value = '';
  document.getElementById('newentity-path-preview').textContent = '';
  const hint = document.getElementById('newentity-hint');
  if (hint) hint.textContent = '';
  document.getElementById('newentity-modal-overlay').hidden = false;
  document.getElementById('newentity-name').focus();
}

function closeNewEntityModal() {
  document.getElementById('newentity-modal-overlay').hidden = true;
}

function updateNewEntityPathPreview() {
  const name = document.getElementById('newentity-name').value;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  document.getElementById('newentity-path-preview').textContent = slug;
}

async function createEntity() {
  if (!currentSandbox) return;
  const sbId = currentSandbox.id;
  const label = document.getElementById('newentity-name').value.trim();
  const hint  = document.getElementById('newentity-hint');
  const btn   = document.getElementById('newentity-create-btn');

  if (!label) {
    document.getElementById('newentity-name').focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Création…';
  if (hint) { hint.textContent = ''; hint.style.color = ''; }

  try {
    const r = await fetch(`${API}/api/sandboxes/${sbId}/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${r.status}`);
    }

    ENTITIES[sbId] = ENTITIES[sbId] || [];
    ENTITIES[sbId].push(data.entity);
    PROJECTS[sbId] = PROJECTS[sbId] || [];

    closeNewEntityModal();
    renderProjectsTab();
    renderSidebar();
  } catch (err) {
    if (hint) {
      hint.style.color = 'var(--error, #EF4444)';
      hint.textContent = `✗ ${err.message}`;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Créer l'entity";
  }
}

// Close modal on overlay click
document.getElementById('modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

document.getElementById('newentity-modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeNewEntityModal();
});

// ─── ECA LOGIN FLOW ──────────────────────────────────────────
let _ecaLoginSession = null;
let _ecaLoginWaitReq = null;

function ecaLoginShow(visible) {
  document.getElementById('sd-auth-login-box').style.display = visible ? 'block' : 'none';
}
function ecaLoginStep(urlVisible, spinnerVisible) {
  document.getElementById('sd-auth-login-url-step').style.display  = urlVisible     ? 'block' : 'none';
  document.getElementById('sd-auth-login-spinner').style.display   = spinnerVisible ? 'block' : 'none';
}
function ecaLoginSpinner(msg) { ecaLoginStep(false, true); document.getElementById('sd-auth-login-spinner').textContent = '⏳ ' + msg; }

async function ecaLoginFlow(provider) {
  const labels = { anthropic: 'Anthropic', 'github-copilot': 'GitHub Copilot' };
  document.getElementById('sd-auth-login-title').textContent = '🔐 Connexion — ' + (labels[provider] || provider);
  document.getElementById('sd-auth-login-code-block').style.display  = 'none';
  document.getElementById('sd-auth-login-input-block').style.display = 'none';
  ecaLoginShow(true);
  ecaLoginSpinner('Démarrage du subprocess ECA…');
  showAuthMsg('muted', '');

  try {
    const r    = await fetch(`${API}/api/auth/eca-login/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    });
    const data = await r.json();
    if (!data.ok) { ecaLoginShow(false); showAuthMsg('error', '✗ ' + data.error); return; }

    _ecaLoginSession = data.sessionId;

    if (data.action === 'done') {
      ecaLoginShow(false);
      showAuthMsg('ok', '✓ Déjà authentifié');
      await refreshAuthStatus();
      return;
    }

    // Afficher l'URL
    ecaLoginStep(true, false);
    const urlEl  = document.getElementById('sd-auth-login-url');
    const msgEl  = document.getElementById('sd-auth-login-msg');
    msgEl.textContent = data.message || '1. Ouvrez ce lien dans votre navigateur :';
    if (data.url) { urlEl.href = data.url; urlEl.textContent = data.url; }

    if (data.action === 'device-code') {
      // GitHub Copilot : afficher le code, attendre providers/updated
      document.getElementById('sd-auth-login-code-block').style.display = 'block';
      document.getElementById('sd-auth-login-code').textContent = data.userCode || '';
      _ecaWaitDeviceCode();

    } else if (data.action === 'authorize' || data.action === 'input') {
      // Anthropic : afficher le champ de saisie du code retour
      document.getElementById('sd-auth-login-input-block').style.display = 'block';
      const fields = data.fields || [];
      if (fields.length) {
        const f = fields[0];
        document.getElementById('sd-auth-login-field-label').textContent = (f.label || 'Code') + ' :';
        const inp = document.getElementById('sd-auth-login-field-input');
        inp.type = (f.type === 'secret') ? 'password' : 'text';
        inp.placeholder = 'Collez le code ici…';
        inp.value = '';
        inp.focus();
      }

    } else if (data.action === 'choose-method') {
      // Rare — on prend la première méthode disponible automatiquement
      const methods = data.methods || [];
      if (methods.length) {
        ecaLoginSpinner(`Méthode sélectionnée : ${methods[0].label}…`);
        const r2 = await fetch(`${API}/api/auth/eca-login/start`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, method: methods[0].key }),
        });
        const d2 = await r2.json();
        if (!d2.ok) { ecaLoginShow(false); showAuthMsg('error', '✗ ' + d2.error); return; }
        _ecaLoginSession = d2.sessionId;
        // Re-enter flow with new session (simplified: reload)
        await ecaLoginFlow(provider);
      }
    }

  } catch (e) {
    ecaLoginShow(false);
    showAuthMsg('error', '✗ ' + e.message);
  }
}

function _ecaWaitDeviceCode() {
  if (!_ecaLoginSession) return;
  const es = new EventSource(`${API}/api/auth/eca-login/${_ecaLoginSession}/wait`);
  _ecaLoginWaitReq = es;
  es.addEventListener('done', async () => {
    es.close(); _ecaLoginWaitReq = null;
    ecaLoginShow(false);
    showAuthMsg('ok', '✓ Authentifié avec succès — eca-server redémarré');
    await refreshAuthStatus();
    setTimeout(refreshEcaStatus, 7000);
  });
  es.addEventListener('error', (e) => {
    es.close(); _ecaLoginWaitReq = null;
    let msg = 'Erreur pendant l\'attente';
    try { msg = JSON.parse(e.data).message; } catch {}
    ecaLoginShow(false);
    showAuthMsg('error', '✗ ' + msg);
  });
}

async function ecaLoginSubmit() {
  if (!_ecaLoginSession) return;
  const code = document.getElementById('sd-auth-login-field-input').value.trim();
  if (!code) return;
  ecaLoginSpinner('Validation du code…');
  try {
    const r = await fetch(`${API}/api/auth/eca-login/${_ecaLoginSession}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { code } }),
    });
    const d = await r.json();
    if (d.ok && d.done) {
      ecaLoginShow(false);
      showAuthMsg('ok', '✓ Authentifié avec succès — eca-server redémarré');
      await refreshAuthStatus();
      setTimeout(refreshEcaStatus, 7000);
    } else if (!d.ok) {
      ecaLoginStep(true, false);
      document.getElementById('sd-auth-login-input-block').style.display = 'block';
      showAuthMsg('error', '✗ ' + (d.error || 'Code invalide'));
      if (d.detail) {
        const msgEl = document.getElementById('sd-auth-msg');
        if (msgEl) {
          const pre = document.createElement('pre');
          pre.style.cssText = 'margin:6px 0 0;font-size:11px;opacity:.75;white-space:pre-wrap;word-break:break-all;text-align:left;';
          pre.textContent = 'Détail Anthropic : ' + (typeof d.detail === 'object' ? JSON.stringify(d.detail, null, 2) : String(d.detail));
          msgEl.appendChild(pre);
        }
      }
    }
  } catch (e) {
    ecaLoginStep(true, false);
    showAuthMsg('error', '✗ ' + e.message);
  }
}

function ecaLoginCancel() {
  if (_ecaLoginWaitReq) { _ecaLoginWaitReq.close(); _ecaLoginWaitReq = null; }
  if (_ecaLoginSession) {
    fetch(`${API}/api/auth/eca-login/${_ecaLoginSession}`, { method: 'DELETE' }).catch(() => {});
    _ecaLoginSession = null;
  }
  ecaLoginShow(false);
}

// ─── AUTH STATUS ─────────────────────────────────────────────
async function refreshAuthStatus() {
  const grid   = document.getElementById('sd-auth-status-grid');
  const navDot = document.getElementById('sd-auth-nav-dot');
  const pill   = document.getElementById('svc-auth');
  if (!grid) return;
  try {
    const r    = await fetch(`${API}/api/auth/status`);
    const data = await r.json();

    if (!data.ok || !data.sources || data.sources.length === 0) {
      grid.innerHTML = '<div style="color:var(--error);font-size:11px">⚠ Aucun credential configuré — renseignez une clé API ci-dessous.</div>';
      if (navDot) navDot.style.background = 'var(--error)';
      if (pill) { pill.hidden = false; pill.querySelector('span').textContent = '🔑 Non authentifié'; }
      return;
    }
    if (pill) pill.hidden = true;

    let hasActive = false;
    const now = Date.now() / 1000;
    grid.innerHTML = data.sources.map(s => {
      const expired = s.expiresAt && s.expiresAt < now;
      const expireSoon = s.expiresAt && !expired && (s.expiresAt - now) < 3600;
      const color = expired ? 'var(--error)' : expireSoon ? 'var(--warn)' : '#28C840';
      if (s.active && !expired) hasActive = true;
      const expStr = s.expiresAt
        ? new Date(s.expiresAt * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
        : null;
      const sourceLabel = s.source === 'eca-native' ? 'OAuth ECA (Emacs)' : s.source === 'webapp' ? 'Clé webapp' : 'Variable env';
      return `<div class="sd-toggle-row" style="margin:0;padding:8px 10px;background:var(--surface-2);border-radius:6px">
        <div style="min-width:0">
          <div class="sd-toggle-label" style="font-size:12px">${s.provider}</div>
          <div class="sd-toggle-sub">${sourceLabel} · mode : <code style="font-size:10px">${s.mode}</code>${expStr ? ` · expire ${expStr}` : ''}</div>
        </div>
        <span style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></span>
      </div>`;
    }).join('');

    if (navDot) navDot.style.background = hasActive ? '#28C840' : '#FEBC2E';
    if (pill) {
      if (!hasActive) {
        pill.hidden = false;
        pill.querySelector('span').textContent = '🔑 Credential expiré';
      } else {
        pill.hidden = true;
      }
    }
  } catch (e) {
    if (grid) grid.innerHTML = `<div style="color:var(--error);font-size:11px">Erreur /api/auth/status : ${e.message}</div>`;
  }
}

async function saveAuthApiKey() {
  const provider = document.getElementById('sd-auth-provider').value;
  const apiKey   = (document.getElementById('sd-auth-apikey').value || '').trim();
  const msg      = document.getElementById('sd-auth-msg');
  if (!apiKey) {
    showAuthMsg('error', '✗ Clé API vide');
    return;
  }
  showAuthMsg('muted', '⏳ Enregistrement en cours…');
  try {
    const r    = await fetch(`${API}/api/auth/apikey`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey }),
    });
    const data = await r.json();
    if (data.ok) {
      const reloadOk = data.reload && data.reload.ok;
      const reloadMsg = reloadOk ? '✓ eca-server redémarré' : `⚠ reload : ${(data.reload && data.reload.body) || 'socket Docker indisponible'}`;
      showAuthMsg('ok', `✓ Clé ${provider} enregistrée. ${reloadMsg}`);
      document.getElementById('sd-auth-apikey').value = '';
      await refreshAuthStatus();
    } else {
      showAuthMsg('error', `✗ ${data.error || 'Erreur inconnue'}`);
    }
  } catch (e) {
    showAuthMsg('error', `✗ ${e.message}`);
  }
}

async function reloadEcaServer() {
  showAuthMsg('muted', '⟳ Redémarrage eca-server en cours…');
  try {
    const r    = await fetch(`${API}/api/auth/reload-eca`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const data = await r.json();
    if (data.ok) {
      showAuthMsg('ok', `✓ eca-server redémarré (${data.container})`);
      // Re-check health after restart (delay ~5s)
      setTimeout(refreshEcaStatus, 6000);
    } else {
      showAuthMsg('warn', `⚠ ${data.result && data.result.body ? data.result.body : 'Vérifiez que /var/run/docker.sock est monté dans le conteneur chorus-web.'}`);
    }
  } catch (e) {
    showAuthMsg('error', `✗ ${e.message}`);
  }
}

function showAuthMsg(level, text) {
  const msg = document.getElementById('sd-auth-msg');
  if (!msg) return;
  const colors = { ok: '#28C840', warn: 'var(--warn)', error: 'var(--error)', muted: 'var(--text-muted)' };
  msg.style.display = 'block';
  msg.style.color   = colors[level] || 'var(--text-muted)';
  msg.textContent   = text;
}

// ─── ECA SERVICE STATUS — real ping (replaces the old simulation) ─────
async function bootServices() {
  await Promise.all([refreshEcaStatus(), refreshAuthStatus(), refreshEngineBadge()]);
  // Re-checks periodically (detects an eca-server going down/coming back).
  setInterval(refreshEcaStatus, 30000);
  setInterval(refreshEngineBadge, 30000);
  // "Active ECA sessions" badge — lightweight polling, independent of the
  // server online/offline status (purely informational, modifies nothing).
  refreshActiveTerminals();
  setInterval(refreshActiveTerminals, 8000);
}

// ─── ENGINE BADGE — version réelle Chorus::Engine + statut dérivé ──────
// Source : GET /api/eca/version (perl -MChorus / -MChorus::Engine, voir
// server/routes/eca.js) + GET /api/eca/health (déjà utilisé par svc-eca).
// États : LIVE (module OK + eca-server joignable) · DEGRADED (module OK,
// eca-server injoignable) · OFFLINE (module Chorus::Engine en échec).
async function refreshEngineBadge() {
  const badge = document.getElementById('engine-badge');
  if (!badge) return;
  try {
    const [vRes, hRes] = await Promise.all([
      fetch(`${API}/api/eca/version`).then(r => r.json()).catch(() => ({ ok: false })),
      fetch(`${API}/api/eca/health`).then(r => r.json()).catch(() => ({ ok: false })),
    ]);

    const version = vRes.version || '?';
    let state, label;
    if (!vRes.engineOk) {
      state = 'offline'; label = `engine v${version} · OFFLINE`;
    } else if (!hRes.ok) {
      state = 'degraded'; label = `engine v${version} · DEGRADED`;
    } else {
      state = ''; label = `engine v${version} · LIVE`;
    }

    badge.className = 'engine-badge' + (state ? ' ' + state : '');
    badge.textContent = label;
    badge.title = [
      `Chorus::Engine ${version}`,
      vRes.installedAt ? `installé le ${new Date(vRes.installedAt).toLocaleString('fr-FR')}` : null,
      vRes.error ? `⚠ ${vRes.error}` : null,
      !hRes.ok ? 'eca-server injoignable' : null,
    ].filter(Boolean).join(' · ');
  } catch (e) {
    badge.className = 'engine-badge offline';
    badge.textContent = 'engine ? · OFFLINE';
    badge.title = `Erreur de vérification : ${e.message}`;
  }
}

let _activeTerminalsCache = [];

async function refreshActiveTerminals() {
  try {
    const r = await fetch(`${API}/api/terminals/active`);
    const data = await r.json();
    _activeTerminalsCache = (data && data.sessions) || [];
  } catch { _activeTerminalsCache = []; }

  const badge = document.getElementById('eca-active-terminals-badge');
  const count = document.getElementById('eca-active-terminals-count');
  if (!badge || !count) return;
  const n = _activeTerminalsCache.length;
  badge.hidden = n === 0;
  count.textContent = n === 1 ? '1 session active' : `${n} sessions actives`;

  // If the panel is open, keep it live-synced.
  const panel = document.getElementById('eca-active-terminals-panel');
  if (panel && !panel.hidden) renderActiveTerminalsPanel();
}

function toggleActiveTerminalsPanel() {
  const panel = document.getElementById('eca-active-terminals-panel');
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    renderActiveTerminalsPanel();
    setTimeout(() => document.addEventListener('click', _eatOutsideClickHandler), 0);
  } else {
    document.removeEventListener('click', _eatOutsideClickHandler);
  }
}

function _eatOutsideClickHandler(e) {
  const panel = document.getElementById('eca-active-terminals-panel');
  const badge = document.getElementById('eca-active-terminals-badge');
  if (!panel || panel.hidden) return;
  if (panel.contains(e.target) || badge.contains(e.target)) return;
  panel.hidden = true;
  document.removeEventListener('click', _eatOutsideClickHandler);
}

function fmtElapsed(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}`;
}

/**
 * Renders the list of active ECA sessions. Each entry opens, on click,
 * an ECA terminal at the exact level/context of the session (sandbox / entity /
 * project / report) via goToActiveTerminal() — it is NOT possible to attach to
 * the SSE stream already in progress elsewhere (it is an HTTP streamed request
 * belonging to the tab/window that opened it, not an independent pub/sub channel):
 * a new terminal/session is therefore opened on that same context, rather than
 * simply navigating to the project page.
 */
function renderActiveTerminalsPanel() {
  const panel = document.getElementById('eca-active-terminals-panel');
  if (!panel) return;
  const sessions = _activeTerminalsCache;

  if (!sessions.length) {
    panel.innerHTML = `<div class="eat-header">Sessions ECA actives</div><div class="eat-empty">Aucune session en cours.</div>`;
    return;
  }

  const levelLabel = { sandbox: 'sandbox', entity: 'entity', project: 'projet', report: 'rapport' };
  const items = sessions.map((s, i) => {
    const target = s.entityId ? `${s.sbId}/${s.entityId}${s.projId ? '/' + s.projId : ''}` : s.sbId;
    return `
      <div class="eat-item" onclick="goToActiveTerminal(${i})">
        <div class="eat-item-top">
          <span class="eat-item-level">${levelLabel[s.level] || s.level}</span>
          <span class="eat-item-sb">${target}</span>
          <span class="eat-item-elapsed">${fmtElapsed(s.elapsedMs)}</span>
        </div>
        ${s.lastMessage ? `<div class="eat-item-msg">${escapeHtml(s.lastMessage)}</div>` : ''}
      </div>`;
  }).join('');

  panel.innerHTML = `<div class="eat-header">Sessions ECA actives (${sessions.length})</div>${items}`;
}

/** Opens the ECA terminal at the exact level/context of the clicked active
 * session (sandbox / entity / project / report), rather than simply
 * navigating to the project page. It is not possible to "attach" to the SSE
 * stream already in progress server-side (an HTTP streamed request belonging
 * to the tab/window that opened it — see note in renderActiveTerminalsPanel):
 * a new terminal is opened for the same context, with its own session, but
 * displayed directly in the correct terminal window rather than redirecting
 * to the project list/card. */
function goToActiveTerminal(sessionIndex) {
  document.getElementById('eca-active-terminals-panel').hidden = true;
  const s = _activeTerminalsCache[sessionIndex];
  if (!s) return;

  // Ensure the sandbox (and therefore PROJECTS/ENTITIES) is loaded
  // before opening the terminal, so that the project/entity level
  // welcome message has the correct data (names, frames, etc.).
  if (currentSandbox?.id !== s.sbId) selectSandbox(s.sbId);

  const level = s.level || 'sandbox';
  if (level === 'sandbox') {
    openLevelTerminal('sandbox', { sbId: s.sbId });
  } else if (level === 'entity') {
    openLevelTerminal('entity', { sbId: s.sbId, entityId: s.entityId });
  } else if (level === 'project') {
    const proj = (PROJECTS[s.sbId] || []).find(p => p.id === s.projId);
    openLevelTerminal('project', {
      sbId: s.sbId, entityId: s.entityId, projId: s.projId,
      projName: proj ? proj.name : s.projId,
    });
  } else if (level === 'report') {
    openLevelTerminal('report', {
      sbId: s.sbId, entityId: s.entityId, projId: s.projId,
      reportFile: s.reportFile,
    });
  } else {
    selectSandbox(s.sbId);
  }
}

async function refreshEcaStatus() {
  const eca   = document.getElementById('svc-eca');
  const mdEca = document.getElementById('svc-modal-eca');
  try {
    const r = await fetch(`${API}/api/eca/health`);
    const data = await r.json();
    const cls = data.ok ? 'svc-pill online' : 'svc-pill offline';
    eca.className = cls;
    eca.title = data.ok ? `eca-server OK (${data.latencyMs}ms)` : `eca-server injoignable : ${data.error}`;
    if (mdEca) mdEca.className = cls;
  } catch (e) {
    eca.className = 'svc-pill offline';
    eca.title = `Health-check /api/eca/health en échec : ${e.message}`;
    if (mdEca) mdEca.className = 'svc-pill offline';
  }
}

// ─── SERVICES MODAL ───────────────────────────────────────────
function openServicesModal() {
  document.getElementById('services-modal-overlay').hidden = false;
  refreshServicesModalData();
  refreshServicesModalAuth();
}
function closeServicesModal() {
  document.getElementById('services-modal-overlay').hidden = true;
}

// Indicateur "Authentifié oui/non" dans la modale Services — réutilise
// GET /api/auth/status (même source que le panneau Config § Authentification
// et la pill topbar #svc-auth), affiché ici en complément du statut
// online/offline du service ECA Server lui-même.
async function refreshServicesModalAuth() {
  const pill   = document.getElementById('svc-modal-auth');
  const detail = document.getElementById('svc-modal-auth-detail');
  if (!pill) return;
  try {
    const r    = await fetch(`${API}/api/auth/status`);
    const data = await r.json();
    const now  = Date.now() / 1000;
    const hasActive = data.ok && Array.isArray(data.sources) && data.sources.some(
      (s) => s.active && !(s.expiresAt && s.expiresAt < now)
    );
    pill.className = 'svc-pill ' + (hasActive ? 'online' : 'offline');
    pill.innerHTML = `<div class="svc-dot"></div>${hasActive ? 'authentifié' : 'non authentifié'}`;
    if (detail) {
      detail.textContent = hasActive
        ? (data.sources || []).map((s) => `${s.provider} (${s.source === 'eca-native' ? 'OAuth ECA' : s.source === 'webapp' ? 'webapp' : 'env'})`).join(', ')
        : 'Aucun credential actif — voir ⚙️ Configuration › Authentification';
    }
  } catch (e) {
    pill.className = 'svc-pill offline';
    pill.innerHTML = `<div class="svc-dot"></div>erreur`;
    if (detail) detail.textContent = e.message;
  }
}

function showServicesModalMsg(level, text) {
  const msg = document.getElementById('svc-modal-msg');
  if (!msg) return;
  const colors = { ok: '#28C840', warn: 'var(--warn)', error: 'var(--error)', muted: 'var(--text-muted)' };
  msg.style.display = 'block';
  msg.style.color   = colors[level] || 'var(--text-muted)';
  msg.textContent   = text;
}

// Bouton "Redémarrer" de la modale Services — même route que l'onglet
// Config § Authentification (reloadEcaServer/showAuthMsg), mais affiché
// dans #svc-modal-msg (propre à cette modale) pour ne pas dépendre du
// panneau Config, potentiellement fermé pendant ce redémarrage.
async function reloadEcaServerFromServices() {
  showServicesModalMsg('muted', '⟳ Redémarrage eca-server en cours…');
  try {
    const r    = await fetch(`${API}/api/auth/reload-eca`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const data = await r.json();
    if (data.ok) {
      showServicesModalMsg('ok', `✓ eca-server redémarré (${data.container})`);
      setTimeout(() => { refreshEcaStatus(); refreshServicesModalAuth(); }, 6000);
    } else {
      showServicesModalMsg('warn', `⚠ ${data.result && data.result.body ? data.result.body : 'Vérifiez que /var/run/docker.sock est monté dans le conteneur chorus-web.'}`);
    }
  } catch (e) {
    showServicesModalMsg('error', `✗ ${e.message}`);
  }
}

// ─── Services modal — données réelles (config + latence) ──────
async function refreshServicesModalData() {
  try {
    const r = await fetch(`${API}/api/eca/info`);
    const info = await r.json();
    const cfgEl = document.getElementById('svc-real-config');
    if (cfgEl) {
      cfgEl.innerHTML =
        `<span class="yml-head">provider:</span>\n` +
        `  <span class="yml-key">type</span>: <span class="yml-val">${info.providerType || '—'}</span>\n\n` +
        `<span class="yml-head">models:</span>\n` +
        `  <span class="yml-key">default</span>: <span class="yml-val">${info.defaultModel || '—'}</span>\n` +
        `  <span class="yml-key">architect</span>: <span class="yml-val">${info.modelArchitect || '—'}</span>\n` +
        `  <span class="yml-key">code</span>: <span class="yml-val">${info.modelCode || '—'}</span>\n` +
        `  <span class="yml-key">fast</span>: <span class="yml-val">${info.modelFast || '—'}</span>\n\n` +
        `<span class="yml-head">server:</span>\n` +
        `  <span class="yml-key">url</span>: <span class="yml-val">${info.serverUrl}</span>\n` +
        `  <span class="yml-key">binary</span>: <span class="yml-val">${info.binary}</span>  <span class="yml-cmt"># pas de JVM, pas de JAR</span>`;
    }
  } catch (e) {
    const cfgEl = document.getElementById('svc-real-config');
    if (cfgEl) cfgEl.innerHTML = `<span class="yml-cmt"># indisponible : ${e.message}</span>`;
  }

  try {
    const r2 = await fetch(`${API}/api/eca/health`);
    const h  = await r2.json();
    drawLatencySparkline(h.history || []);
    const label = document.getElementById('svc-latency-label');
    if (label) label.textContent = h.history && h.history.length ? `(dernière : ${h.latencyMs}ms, ${h.history.length} mesures)` : '';
  } catch { /* sparkline laissée vide si health-check indisponible */ }
}

function drawLatencySparkline(history) {
  const canvas = document.getElementById('svc-latency-sparkline');
  if (!canvas || !history || !history.length) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(...history, 1);
  const step = w / Math.max(history.length - 1, 1);
  ctx.strokeStyle = '#4E9BF5';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  history.forEach((v, i) => {
    const x = i * step;
    const y = h - (v / max) * (h - 6) - 3;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // Dernier point
  const lastX = (history.length - 1) * step;
  const lastY = h - (history[history.length - 1] / max) * (h - 6) - 3;
  ctx.fillStyle = '#4E9BF5';
  ctx.beginPath();
  ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
  ctx.fill();
}
document.getElementById('services-modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeServicesModal();
});

// ─── PIPELINE ECA-DISPATCH LOGS ──────────────────────────────
// Wrap runPipeline to add ECA dispatch prefix logs
const _origEcaShowCmd = ecaShowCmd;
function ecaShowDispatch(cmd, isEcaSkill) {
  if (isEcaSkill) {
    // Show ECA dispatch trace before the actual command
    const log = document.getElementById('pipeline-log');
    const dispatch = document.createElement('div');
    dispatch.className = 'eca-line';
    dispatch.innerHTML = `<span class="eca-ts">${ecaTs()}</span><span style="color:#2A5A8A">[Chorus::ECA::Client] dispatch → ws://localhost:7777</span>`;
    log.appendChild(dispatch);
    const route = document.createElement('div');
    route.className = 'eca-line';
    route.innerHTML = `<span class="eca-ts">${ecaTs()}</span><span style="color:#1E4A6A">[ECA] skill: <span style="color:#5A9ED4">${cmd.split(' ')[0]}</span> · session: eca-${Math.random().toString(36).slice(2,6)}</span>`;
    log.appendChild(route);
    log.scrollTop = log.scrollHeight;
  }
  ecaShowCmd(cmd);
}

// ─── SETTINGS ─────────────────────────────────────────────────
function openSettings(tabId) {
  document.getElementById('settings-overlay').hidden = false;
  document.getElementById('settings-drawer').hidden = false;
  if (tabId) switchSettingsTab(tabId, document.querySelector(`.sd-nav-item[onclick*="${tabId}"]`));
}

function closeSettings() {
  document.getElementById('settings-overlay').hidden = true;
  document.getElementById('settings-drawer').hidden = true;
}

function switchSettingsTab(id, el) {
  document.querySelectorAll('.sd-section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.sd-nav-item').forEach(n=>n.classList.remove('active'));
  const sec = document.getElementById('sd-'+id);
  if (sec) sec.classList.add('active');
  if (el) el.classList.add('active');
}

async function pingEcaServer() {
  const dot = document.getElementById('sd-eca-dot');
  const txt = document.getElementById('sd-eca-status-text');
  dot.className = 'sd-status-dot'; dot.style.background = 'var(--warn)';
  txt.textContent = 'Test en cours…';
  try {
    const r = await fetch(`${API}/api/eca/health`);
    const data = await r.json();
    if (data.ok) {
      dot.className = 'sd-status-dot connected';
      txt.textContent = `Connecté · https://eca-server:7777 (${data.latencyMs}ms)`;
    } else {
      dot.className = 'sd-status-dot';
      dot.style.background = 'var(--error)';
      txt.textContent = `Injoignable : ${data.error}`;
    }
  } catch (e) {
    dot.className = 'sd-status-dot';
    dot.style.background = 'var(--error)';
    txt.textContent = `Erreur : ${e.message}`;
  }
}

// Populates the read-only fields in the LLM Models tab with the
// real active values (same data as the Services panel).
async function refreshModelsReadonly() {
  try {
    const r = await fetch(`${API}/api/eca/info`);
    const info = await r.json();
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || '—'; };
    set('sd-m-provider-ro', info.providerType);
    set('sd-m-architect-ro', info.modelArchitect);
    set('sd-m-code-ro', info.modelCode);
    set('sd-m-fast-ro', info.modelFast);
  } catch (e) { console.warn('Impossible de charger /api/eca/info :', e.message); }
}

function applyThemeFromSettings(val) {
  if (val==='dark') document.documentElement.setAttribute('data-theme','dark');
  else if (val==='light') document.documentElement.setAttribute('data-theme','light');
  else document.documentElement.removeAttribute('data-theme');
}

function applyDensityFromSettings(val) {
  if (val === 'compact') document.documentElement.setAttribute('data-density', 'compact');
  else document.documentElement.removeAttribute('data-density');
}

// Triggers a real browser notification (Notification API) if the user has
// enabled "Browser notifications" in Settings > Interface and granted
// permission. Requests permission silently if it has never been requested
// (without blocking the current call — the notification will only appear
// on subsequent calls in that case, standard behaviour of the asynchronous
// Notification API which requires a prior user gesture).
function notifyBrowser(title, body) {
  if (!SETTINGS.ui.notifications) return;
  if (!window.Notification) return;
  if (Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: undefined }); } catch { /* ignore */ }
  } else if (Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function saveSettings() {
  SETTINGS.ui.theme = document.getElementById('sd-ui-theme').value;
  SETTINGS.ui.language = document.getElementById('sd-ui-lang').value;
  SETTINGS.ui.density = document.getElementById('sd-ui-density').value;
  SETTINGS.ui.notifications = document.getElementById('sd-ui-notif').checked;
  applyThemeFromSettings(SETTINGS.ui.theme);
  applyDensityFromSettings(SETTINGS.ui.density);
  if (SETTINGS.ui.notifications && window.Notification && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  try {
    localStorage.setItem('chorus-web-settings-ui', JSON.stringify(SETTINGS.ui));
  } catch (e) { console.warn('Impossible de sauvegarder les préférences UI :', e.message); }
  closeSettings();
}

// Sauvegarde du timeout terminal (panneau Config § ECA Server) — séparé de
// saveSettings() (bouton "Enregistrer" global) car ce champ a son propre
// onchange, pour un effet immédiat sans attendre la fermeture du panneau.
function saveEcaTimeoutSetting() {
  const input = document.getElementById('sd-eca-timeout');
  if (!input) return;
  let minutes = parseInt(input.value, 10);
  if (!Number.isFinite(minutes) || minutes < 1) minutes = 60;
  if (minutes > 240) minutes = 240;
  input.value = minutes;
  SETTINGS.eca.terminalTimeoutMinutes = minutes;
  try {
    localStorage.setItem('chorus-web-settings-eca', JSON.stringify(SETTINGS.eca));
  } catch (e) { console.warn('Impossible de sauvegarder le timeout terminal :', e.message); }
}

// Loads persisted UI preferences (localStorage) at boot — only the
// preferences actually applied in JS (theme/density/notifications) are
// concerned. "Language" is kept in SETTINGS/localStorage to not lose the
// user's choice, but has no effect (no i18n — see "next version" badge in
// the select). Other sections (Workspace, ECA Server, Models, Pipeline) are
// read-only: their values come from the server environment
// (docker-compose.yml/.env), never from this localStorage.
function loadSettingsFromStorage() {
  try {
    const raw = localStorage.getItem('chorus-web-settings-ui');
    if (!raw) return;
    const saved = JSON.parse(raw);
    Object.assign(SETTINGS.ui, saved);
    applyThemeFromSettings(SETTINGS.ui.theme);
    applyDensityFromSettings(SETTINGS.ui.density);
    const themeSel = document.getElementById('sd-ui-theme');
    const langSel  = document.getElementById('sd-ui-lang');
    const densSel  = document.getElementById('sd-ui-density');
    const notifChk = document.getElementById('sd-ui-notif');
    if (themeSel) themeSel.value = SETTINGS.ui.theme;
    if (langSel)  langSel.value  = SETTINGS.ui.language;
    if (densSel)  densSel.value  = SETTINGS.ui.density;
    if (notifChk) notifChk.checked = !!SETTINGS.ui.notifications;
  } catch (e) { console.warn('Préférences UI corrompues, ignorées :', e.message); }

  try {
    const rawEca = localStorage.getItem('chorus-web-settings-eca');
    if (rawEca) Object.assign(SETTINGS.eca, JSON.parse(rawEca));
  } catch (e) { console.warn('Préférence timeout ECA corrompue, ignorée :', e.message); }
  const timeoutInput = document.getElementById('sd-eca-timeout');
  if (timeoutInput) timeoutInput.value = SETTINGS.eca.terminalTimeoutMinutes;
}

function exportSettingsJSON() {
  const blob = new Blob([JSON.stringify(SETTINGS, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'chorus-settings.json';
  a.click();
}

// ─── BOOT ─────────────────────────────────────────────────────
init();
bootServices();
loadSettingsFromStorage();
initFromServer(); // surcharge avec les données réelles si le serveur MVP0 répond
