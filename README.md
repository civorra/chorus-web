# chorus-web

Web interface for **Chorus** — a neuro-symbolic compliance engine (rule-based
inference engine + AI-assisted knowledge base construction, see
[`Chorus::Engine`](../engine)).

`chorus-web` lets an operator drive the Chorus pipeline from a browser instead
of a terminal: import source documents (PDF/DOCX/XLSX/CSV/plain text), launch
compliance checks, follow long-running AI-driven operations in real time
(`chorus-feed`, `chorus-import-project`, `chorus-check`…), and consult
generated reports.

**License:** Artistic License 2.0 — same license as `Chorus::Engine` (see
[`LICENSE`](./LICENSE)).

## Status

Early-stage internal tool (MVP), used alongside `Chorus::Engine` for
real-world sandboxes. Not yet a packaged, distributed product — see
`WIP.org`-style tracking (not committed) for ongoing work.

## Architecture overview

- **Backend** — Node.js (Express ≥ 4, Node ≥ 20): scans sandboxes, serves
  reports, proxies long-running operations to an [ECA](https://eca.dev)
  headless agent session (`eca-client.js`) for anything requiring the AI
  construction pipeline (`chorus-feed`, `chorus-import-project`, …).
- **Frontend** — plain JavaScript (no framework, no bundler):
  `chorus-web.html` / `chorus-web.css` / `chorus-web.js`.
- **`chorus/`** — scanner & parser modules (sandbox discovery, project JSON
  parsing, report reading, thesaurus resolution).
- **`server/`** — Express routers (`routes/`) and helpers (`helpers/`,
  `state.js`) for the HTTP/SSE API.

See [`INTEGRATION.md`](./INTEGRATION.md) for installation, deployment and
configuration details.

## Quick start (Docker — recommended)

```bash
# 1. Clone this repo
git clone --branch devel https://github.com/civorra/chorus-web ~/Chorus/web

# 2. Bootstrap: clones chorus-engine + creates .env
cd ~/Chorus/web
./setup.sh

# 3. Build and start
docker compose up --build -d
# → http://localhost:3000
```

Two services are started: `eca-server` (headless ECA agent, internal network
only) and `chorus` (the application itself, port 3000). See
[`INTEGRATION.md`](./INTEGRATION.md) for full installation instructions and
configuration reference.

## Quick start (local Node.js, no Docker)

```bash
npm install
cp .env.example .env
# edit .env: set CHORUS_HOME, SANDBOXES, and optionally ANTHROPIC_API_KEY_FILE

node server.js
# → http://localhost:3000
```

Requires Node.js ≥ 20. A running `eca-server` instance must be reachable at
`ECA_SERVER_URL` for AI-driven operations to work; sandbox scanning and report
viewing work independently.

## Repository layout

```
chorus-web.html / .css / .js   Frontend (plain JS, no build step)
server.js, server/             Backend Express app (routers, helpers)
chorus/                        Sandbox scanning & parsing modules
eca-client.js                  ECA headless agent client (SSE, chat sessions)
auth.js, prompts.js            Authentication, LLM prompt templates
docker-compose.yml             Container deployment (services: eca-server, chorus)
Dockerfile                     chorus service image (Node + Perl + Python + LibreOffice)
Dockerfile.eca                 eca-server service image (ECA GraalVM binary)
chorus-entrypoint.sh           Container startup: make install + npm install + node
setup.sh                       Host bootstrap: clone engine, create .env
INTEGRATION.md                 Installation, configuration & troubleshooting guide
LICENSE                        Artistic License 2.0
```

## Contributing / conventions

This repository follows the conventions documented in `Chorus::Engine`'s
`AGENTS.md` for anything related to ECA skills and ECA-assisted development
workflow when this repo is used alongside the main engine checkout.
