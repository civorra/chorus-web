# Instructions — Chorus Web

> This file is read automatically at the start of any working session on this repository.
> It defines conventions, skill triggers, and contribution rules for `chorus-web`.

## Paths (relative to the repository root)

| Alias | Path |
|---|---|
| `$WEBAPP` | `.` — repository root |
| `$SKILLS` | `./agent/skills/` — versioned ECA skills |
| `$EAKB` | `./agent/kb/` — ECA KB on chorus-web internals (versioned in git) |

> **Two distinct KB locations:**
> `./agent/kb/` contains the **ECA knowledge base** on chorus-web internals
> (pitfalls, architecture, components) — versioned in git.
> **Not optional:** read before any work on JS source files,
> updated in the same session as any significant change to source files.

## Project

- **Domain:** Node.js / Express web frontend for the Chorus Engine pipeline
- **Stack:** Node.js · Express · Vanilla JS (SPA) · Docker
- **ECA integration:** remote eca-server via HTTPS + SSE (`eca-client.js`)
- **Commits:** conventional format (`type(scope): message`)

## `agent/` — commit rules

- `agent/skills/` — **must be committed**: versioned skills
- `agent/kb/` — **must be committed**: ECA KB on chorus-web internals
- Never run `git add agent/` as a bulk command — always stage explicitly.

## KB webapp ↔ source sync

Whenever a JS source file is significantly modified, update the relevant
`agent/kb/` file in the same session:
- `pitfalls.org` — if a new pitfall is discovered or an existing one is fixed
- `components.org` — if module behaviour or routing logic changes
- `architecture.org` — if the overall data flow or layer structure changes

## Triggers and skills

> **Rule:** When a trigger is received, load the skill via `eca__read_file` on its
> absolute path under `$WEBAPP/agent/skills/` and execute immediately.

| Trigger | Type | Skill | Agent |
|---|---|---|---|
| `deep-webapp [<focus>]` | command | `./agent/skills/deep-webapp.md` — deep implementation analysis of chorus-web JS sources; maps internal data flows, documents non-obvious mechanisms, identifies extension points. Focus options: `eca-client` · `terminal` · `thesaurus` · `auth` · `scanner` *(omit for full analysis)* | `architect` |
| `deep-cross [<focus>]` | command | `$ENGINE/agent/skills/deep-chorus.md` **then** `./agent/skills/deep-webapp.md` → cross-layer deep analysis (Engine Perl + Web Node.js): integration boundary, data contracts, error propagation, KB/state consistency, extension points. Focus options: `eca-bridge` · `pipeline` · `auth` · `thesaurus` *(omit for full cross-layer analysis)* | `architect` |
| `skills [--all]` | meta | `eca__directory_tree $WEBAPP/agent/skills/` → name + status `✅` loaded / `○` available. **Complète la liste de `$ENGINE/agent/skills/`** — afficher les deux répertoires ensemble. Sans `--all` : sous-skills masqués (aucun actuellement dans `$WEBAPP`). | `fast` |
