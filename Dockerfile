FROM node:22-slim

# Perl + outils de build pour compiler/installer les modules Chorus::* via
# ExtUtils::MakeMaker (Makefile.PL / make / make install).
# Python3 + pip + libs système weasyprint (Pango/Cairo/GDK-PixBuf) : requis par
# scripts/md2html.py et scripts/md2pdf.py (export "Save as" HTML/PDF des
# rapports summary/explain depuis le panneau de visualisation — voir
# server.js § ROUTE export-report). Ces deux scripts sont appelés directement
# en subprocess (jamais via un skill ECA), donc le binaire python3 et ses
# dépendances doivent être natifs à cette image, au même titre que perl
# ci-dessus pour Chorus::*.
RUN apt-get update && apt-get install -y --no-install-recommends \
    perl \
    perl-modules \
    make \
    libyaml-perl \
    libjson-perl \
    python3 \
    python3-pip \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgdk-pixbuf2.0-0 \
    libcairo2 \
    libffi-dev \
    shared-mime-info \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages markdown weasyprint

# ── Installation native des modules Chorus::* (CPAN local, depuis les sources) ──
# Contexte de build = racine du dépôt Chorus (voir docker-compose.yml : build.context: ..)
# Les modules sont installés dans l'arborescence perl standard du conteneur :
# plus besoin de PERL5LIB pour que run.pl / Feed.pm / Expert.pm les trouvent.
COPY Engine/Makefile.PL Engine/MANIFEST /usr/src/chorus-engine/
COPY Engine/lib/ /usr/src/chorus-engine/lib/
RUN cd /usr/src/chorus-engine \
    && perl Makefile.PL INSTALLDIRS=site \
    && make \
    && make install \
    && cd / && rm -rf /usr/src/chorus-engine

WORKDIR /app

COPY chorus-web/package.json .
RUN npm install --omit=dev

COPY chorus-web/server.js chorus-web/chorus.js chorus-web/prompts.js chorus-web/eca-client.js chorus-web/auth.js chorus-web/chorus-web.html ./

# CHORUS_HOME est monté en volume depuis l'hôte, uniquement pour les données
# (sandboxes, scripts run.pl générés par sandbox, etc.) — plus pour les
# modules Perl, installés nativement ci-dessus.
ENV CHORUS_HOME=/chorus
ENV PORT=3000

EXPOSE 3000

# Clé Anthropic fournie via secret Docker Compose (/run/secrets/anthropic_api_key,
# jamais en variable d'env de conteneur) — repli sur ANTHROPIC_API_KEY si le
# secret est absent (dev local sans secrets configurés).
CMD ["sh", "-c", "export ANTHROPIC_API_KEY=\"$(cat /run/secrets/anthropic_api_key 2>/dev/null || printf '%s' \"$ANTHROPIC_API_KEY\")\"; exec node server.js"]
