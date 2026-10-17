# Dockerfile multi-stage — contexte de build : racine du dépôt Chorus (..)
#
# Stages :
#   base       — tooling système partagé (Perl, Python, LibreOffice, poppler…)
#   chorus     — service webapp Node.js (port 3000)
#   eca-server — agent ECA headless (port 7777)
#
# Les deux services héritent du stage base : eca-server dispose ainsi de tous
# les outils d'extraction (pdfplumber, python-docx, libreoffice…) nécessaires
# à l'exécution des skills chorus-pdf / chorus-word / chorus-excel via
# eca__shell_command.

# ── Stage base : tooling partagé ─────────────────────────────────────────────
FROM node:22-slim AS base

# Perl + build tools : Chorus::* installés via l'entrypoint (make install).
# Python3/pip + weasyprint : scripts/md2pdf.py et md2html.py.
# Tooling d'extraction documentaire :
#   poppler-utils  → chorus-pdf (pdftotext / pdfinfo)
#   libxml2-utils  → chorus-xml
#   libreoffice-*  → chorus-excel (XLSX→images), chorus-word (DOCX→images)
#   fonts-*        → rendu LibreOffice correct
# curl + unzip : téléchargement du binaire ECA dans le stage eca-server.
#
# ⛔ Absents intentionnellement :
#   @anthropic-ai/claude-code    (Claude Code CLI — concurrent d'ECA)
#   @earendil-works/pi-coding-agent
#   n 22 / nvm  (image de base déjà Node 22)
RUN apt-get update && apt-get install -y --no-install-recommends \
    perl \
    perl-modules \
    cpanminus \
    make \
    libyaml-perl \
    libjson-perl \
    libtest-simple-perl \
    libtest-warn-perl \
    python3 \
    python3-pip \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgdk-pixbuf2.0-0 \
    libcairo2 \
    libffi-dev \
    shared-mime-info \
    poppler-utils \
    libxml2-utils \
    libreoffice-core \
    libreoffice-calc \
    libreoffice-writer \
    fonts-dejavu \
    fonts-liberation \
    curl \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages \
       markdown \
       weasyprint \
       pdfminer.six \
       pypdf \
       pdfplumber \
       Pillow \
       python-docx \
       lxml \
       openpyxl \
       beautifulsoup4

# ── Stage chorus : service webapp Node.js ────────────────────────────────────
FROM base AS chorus

# package.json COPYé pour que npm install soit reproductible dans l'entrypoint.
# Les fichiers serveur/frontend arrivent via le volume /chorus/web.
COPY web/package.json /chorus-bootstrap/package.json
RUN cd /chorus-bootstrap && npm install --omit=dev

COPY web/chorus-entrypoint.sh /usr/local/bin/chorus-entrypoint.sh
RUN chmod +x /usr/local/bin/chorus-entrypoint.sh

ENV CHORUS_HOME=/chorus
ENV PORT=3000
EXPOSE 3000
CMD ["/usr/local/bin/chorus-entrypoint.sh"]

# ── Stage eca-server : agent ECA headless ────────────────────────────────────
FROM base AS eca-server

# Binaire ECA (GraalVM, statiquement lié — pas de JVM requise).
# ⚠️ PINNED — 0.164.0 is the last known-good version for this stack.
# 0.165.0 and 0.165.1 both break ECA terminal SSE streaming: "No matching
# field found: getOutputStream for class org.eclipse.jetty.ee9.nested.Response"
# on GET /api/v1/events and POST /api/v1/chats/:id/agent (confirmed via
# bisection 2026-10-17 — not reported upstream yet as of this pin). Do not
# bump past 0.164.0 without re-running this bisection against the target
# version first.
ARG ECA_VERSION=0.164.0
RUN curl -fsSL -o /tmp/eca.zip \
      https://github.com/editor-code-assistant/eca/releases/download/${ECA_VERSION}/eca-native-static-linux-amd64.zip \
    && unzip /tmp/eca.zip -d /usr/local/bin/ \
    && chmod +x /usr/local/bin/eca \
    && rm /tmp/eca.zip

COPY web/eca-config.json /etc/eca/config.json
COPY web/eca-bootstrap.sh /usr/local/bin/eca-bootstrap.sh
RUN chmod +x /usr/local/bin/eca-bootstrap.sh

# Racine de travail = tout le dépôt Chorus monté en volume, pour que ECA voie
# engine/AGENTS.md, agent/skills/*.md et sandboxes/.
WORKDIR /chorus
EXPOSE 7777
ENTRYPOINT ["/usr/local/bin/eca-bootstrap.sh"]
