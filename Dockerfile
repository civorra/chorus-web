FROM node:22-slim

# ── Tooling système ───────────────────────────────────────────────────────────
# Perl + build tools : compile et installe les modules Chorus::* via l'entrypoint.
# Python3/pip + weasyprint : scripts/md2pdf.py et scripts/md2html.py.
# Tooling d'extraction documentaire (fusion depuis engine/Dockerfile) :
#   poppler-utils    → chorus-pdf (pdftotext/pdfinfo)
#   libxml2-utils    → chorus-xml
#   libreoffice-*    → chorus-excel (XLSX→images), chorus-word (DOCX→images)
#   fonts-*          → rendu LibreOffice correct
# Tooling Python d'extraction :
#   pdfminer.six, pypdf, pdfplumber → chorus-pdf
#   python-docx, lxml               → chorus-word  (lxml requis par python-docx)
#   openpyxl, Pillow                → chorus-excel
#   beautifulsoup4                  → parsing HTML/XML annexe
#
# ⛔ Absents intentionnellement :
#   - @anthropic-ai/claude-code    (Claude Code CLI — concurrent d'ECA)
#   - @earendil-works/pi-coding-agent (Pi Coding Agent)
#   - `n 22` / nvm                 (image de base déjà Node 22)
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

# ── Modules Perl CPAN complémentaires ─────────────────────────────────────────
RUN cpanm --notest JSON Digest::MD5 File::Temp

# ── npm — dépendances installées dans le volume node_modules_chorus ───────────
# package.json est COPYé uniquement pour que `npm install` soit
# reproductible dans l'entrypoint sans accès réseau si le layer est déjà
# présent. Les fichiers serveur/frontend arrivent via le volume /chorus/web.
COPY web/package.json /chorus-bootstrap/package.json
RUN cd /chorus-bootstrap && npm install --omit=dev

# ── Entrypoint ────────────────────────────────────────────────────────────────
# Effectue make install des modules Chorus::*, npm install si node_modules
# est vide, puis lance node server.js depuis /chorus/web.
COPY web/chorus-entrypoint.sh /usr/local/bin/chorus-entrypoint.sh
RUN chmod +x /usr/local/bin/chorus-entrypoint.sh

ENV CHORUS_HOME=/chorus
ENV PORT=3000

EXPOSE 3000

CMD ["/usr/local/bin/chorus-entrypoint.sh"]
