# Skill — deep-webapp

> **Trigger:** `deep-webapp [<focus>]`
> **Agent:** `architect`
> **Purpose:** Deep implementation analysis of Chorus Web (`chorus-web`).
> Reads the actual JS source (not just comments), maps internal data flows,
> documents non-obvious mechanisms, and identifies extension points.
> Produces a structured report in `/home/civ/Chorus/eca/sessions/`.
>
> Optional `<focus>` narrows the analysis:
> - `eca-client`  — focus on ECA server communication (SSE, Jetty bugs, agent routing)
> - `terminal`    — focus on the SSE terminal lifecycle (WEB-025 family, ask_user guard)
> - `thesaurus`   — focus on the 3-tier thesaurus architecture and resolution flow
> - `auth`        — focus on OAuth flows (Anthropic PKCE, GitHub Copilot native ECA login)
> - `scanner`     — focus on the filesystem scanner layer (chorus/ package)
> - *(omit for full analysis)*

---

## Webapp KB — read first

The Webapp KB lives in `/home/civ/Chorus/web/agent/kb/`:

| File                | Content                                              |
|---------------------|------------------------------------------------------|
| `pitfalls.org`      | Known pitfalls — **read first** (15+ pitfalls documented) |
| `architecture.org`  | Stack, module layout, data flows, Docker, auth       |
| `components.org`    | Detail of every JS module (routes, chorus/, helpers) |

Read via `eca__read_file` (absolute path):
```
/home/civ/Chorus/web/agent/kb/pitfalls.org
/home/civ/Chorus/web/agent/kb/architecture.org
/home/civ/Chorus/web/agent/kb/components.org
```

**Rule:** read all 3 KB files before reading sources — avoids re-discovering
already documented knowledge. Update the KB if the session reveals new findings.

---

## Existing reference reports (load before reading sources)

Check `/home/civ/Chorus/eca/sessions/` for any report whose name contains `deep-webapp`
or `chorus-web` — load the most recent one before reading sources to avoid re-discovering
already documented behaviour.

```bash
ls -lt /home/civ/Chorus/eca/sessions/ | grep -E 'deep-webapp|chorus-web' | head -5
```

---

## Phase 1 — Source inventory

Read in order (adjust for `<focus>` — omit unrelated files):

```
# Core server
/home/civ/Chorus/web/server.js              # Express entry point, router mounting, .env loading
/home/civ/Chorus/web/server/state.js        # Shared state (activeTerminals, latencyHistory)

# ECA integration (always read for eca-client / terminal focus)
/home/civ/Chorus/web/eca-client.js          # ECA server communication (SSE, polling, login)

# Auth (auth focus or full)
/home/civ/Chorus/web/auth.js                # OAuth PKCE, Docker restart, credential sources

# Chorus filesystem layer (scanner focus or full)
/home/civ/Chorus/web/chorus/fs.js           # CHORUS_HOME, SANDBOXES_DIR, low-level helpers
/home/civ/Chorus/web/chorus/scanner.js      # scanSandbox/scanEntity/scanProject/scanFlatProject
/home/civ/Chorus/web/chorus/parser.js       # .org / README / report parsing
/home/civ/Chorus/web/chorus/reports.js      # parseReport, buildRunReportIndex
/home/civ/Chorus/web/chorus/thesaurus.js    # resolveThesaurusPending, unconfirmThesaurusAlias

# Terminal + thesaurus (terminal / thesaurus focus or full)
/home/civ/Chorus/web/server/routes/terminal.js   # SSE terminal, WEB-025 guard, skill injection
/home/civ/Chorus/web/server/routes/thesaurus.js  # Alias resolution endpoints

# Other routes (full only)
/home/civ/Chorus/web/server/routes/eca.js        # ECA health, chat management
/home/civ/Chorus/web/server/routes/scan.js       # Sandbox scan endpoints
/home/civ/Chorus/web/server/routes/projects.js   # Import/check/complete-report
/home/civ/Chorus/web/server/routes/reports.js    # Report file serving
/home/civ/Chorus/web/server/helpers/sse.js       # SSE primitives
/home/civ/Chorus/web/server/helpers/perl.js      # Perl bridge
/home/civ/Chorus/web/prompts.js                  # LLM system prompts (chorus-check / complete-report)
```

---

## Phase 2 — Key internals to map

### ECA client internals

| Concept                    | Location                | Description                                   |
|----------------------------|-------------------------|-----------------------------------------------|
| `TOOL_FAMILIES`            | `eca-client.js`         | Tool name → family/icon/label (NO eca__ prefix) |
| `classifyToolCall(content)` | `eca-client.js`        | Extracts structured info from SSE tool events |
| `watchedChatIds`           | `subscribeEcaEvents`    | Set of chatIds watched; grows with sub-agents |
| `subscribeLoginFlow`       | `eca-client.js`         | Mutable-handler SSE for ECA /login flow        |
| `promptAndWaitSSE`         | `eca-client.js`         | Preferred one-shot: subscribe BEFORE POST prompt |

### Terminal SSE state machine

| State flag               | Purpose                                               |
|--------------------------|-------------------------------------------------------|
| `waitingForUserInput`    | Prevents idle→finish while ask_user is pending        |
| `postRespondPending`     | WEB-025b: marks "user just replied, expect next idle" |
| `deferredDoneHandle`     | 8s deferred close after ECA goes idle post-respond    |
| `gracePeriodHandle`      | Grace period after user response before clearing guard |
| `lastKnownPendingCount`  | WEB-025d: prevents duplicate close on multiple edits  |

### AGENT_BY_TRIGGER routing

Ordered regex list in `terminal.js` mapping Chorus trigger keywords → ECA agent.
Order matters — first match wins.  Mirrors `ENGINE_AGENTS.md § Triggers and skills`.

### Context block injection (kind-specific)

| kind                        | Extra context injected                                        |
|-----------------------------|---------------------------------------------------------------|
| `strengthen` / `fix`        | Convergence summary from `.last-check-results.json` + gap report |
| `pipeline-feed`             | `instructions-directives.md` + `instructions-scoping.md`     |
| `thesaurus-assistant`       | `thesaurus.org` content + `_a_confirmer` entries from JSON    |
| `reimport-replace` / `thesaurus-reimport` | Niv 2 + Niv 3 thesaurus content          |

### Thesaurus 3-tier architecture

| Tier | File                              | Scope   | Write access             |
|------|-----------------------------------|---------|--------------------------|
| Niv 2 | `workspace/<entity>/<projId>.thesaurus.json` | Project | thesaurus-assistant ECA |
| Niv 3 | `workspace/<entity>/thesaurus.org`  | Entity  | Webapp 🏢 button only    |
| Global | `agent/thesaurus/global.org`      | Sandbox | chorus-import-project    |

---

## Phase 3 — Extension points (focus-specific)

### Focus: `eca-client`

Document:
- The full Jetty 12 workaround chain (P-01 in pitfalls.org)
- `subscribeEcaEvents` — exact event types handled, sub-agent chain tracking
- `classifyToolCall` — `taskboard` and `isSubagent` extraction paths
- `subscribeLoginFlow` — mutable handler pattern and SSE keep-alive requirement
- `setChatAgent` — undocumented REST endpoint (P-03)
- Any newly observed ECA API behaviour not yet in pitfalls.org

### Focus: `terminal`

Document:
- Full WEB-025 family state machine (flags, transitions, edge cases)
- WEB-025d thesaurus proactive close — `lastKnownPendingCount` guard
- WEB-021 refresh trigger — `REFRESH_TRIGGERS` set and SSE event chain
- SKILL_CRITICAL_RULES per skill — completeness vs ENGINE_AGENTS.md
- Any divergence between AGENT_BY_TRIGGER and the actual skill trigger table

### Focus: `thesaurus`

Document:
- `resolveThesaurusPending` / `unconfirmThesaurusAlias` — exact write logic per tier
- `scanSandboxThesaurus` — what it returns, how it feeds the UI tabs
- `hasUnintegratedThesaurus` detection (mtime comparison logic)
- `sourceBasename` derivation chain and silent failure modes (P-07)
- `thesaurus-restart` / `thesaurus-status` SSE events and frontend contract

### Focus: `auth`

Document:
- Full PKCE flow (verifier/challenge, `httpsPost`, User-Agent requirement P-12)
- Anthropic OOB code parsing (`rawCode.split('#')[0]`)
- In-memory session store (`ecaSessions`) — TTL, `dropSession`, `ecaSub` lifecycle
- Copilot device-code flow via ECA `/login github` (P-13 background + current approach)
- `/wait` route — `setHandlers` pattern for attaching late callbacks on existing SSE

### Focus: `scanner`

Document:
- `scanFlatProject` — full field set, `isCoveredByFlatProject` guard (P-14)
- `collectImportHistory` — #+DATE / #+SOURCE / #+OUTPUT_JSON parsing rules (P-07, P-09)
- `readLastCheckResults` — `normalizeHash` (P-15), `stale` detection
- `computeConvergenceFromRunReport` — fallback convergence logic
- `buildRunReportIndex` — dual timestamp format handling (new vs legacy)

---

## Phase 4 — Output

Produce a report `/home/civ/Chorus/eca/sessions/YYYY-MM-DD-HH-MM-deep-webapp-<focus>.md` with:

```markdown
# Deep analysis — Chorus Web [<focus>]

## Summary
<3-5 bullet points: key findings, surprises, confirmed assumptions, discrepancies with KB>

## Internal mechanisms documented
<tables or annotated excerpts — reference file:line where useful>

## New pitfalls found
<any P-NN candidates not yet in pitfalls.org — format as pitfall entries>

## Extension points identified
<concrete list with file and function names>

## KB update recommendations
<list of changes to apply to architecture.org / components.org / pitfalls.org>

## Open questions
<anything requiring user decision before implementation>
```

**After producing the report:**
- If new pitfalls were found: update `pitfalls.org` via `eca__edit_file`
- If architecture changed: update `architecture.org`
- If component details are outdated: update `components.org`

Do not commit the report — it goes to `/home/civ/Chorus/eca/sessions/` (not versioned).
The KB files in `web/agent/kb/` are NOT versioned in git (no git repo in `chorus-web`
at present) — update them in place without any commit step.
