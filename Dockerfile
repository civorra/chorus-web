FROM node:22-slim

# Perl + outils de build pour compiler/installer les modules Chorus::* via
# ExtUtils::MakeMaker (Makefile.PL / make / make install).
RUN apt-get update && apt-get install -y --no-install-recommends \
    perl \
    perl-modules \
    make \
    libyaml-perl \
    && rm -rf /var/lib/apt/lists/*

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

COPY chorus-mvp0-v43/package.json .
RUN npm install --omit=dev

COPY chorus-mvp0-v43/server.js chorus-mvp0-v43/chorus.js chorus-mvp0-v43/prompts.js chorus-mvp0-v43/chorus-web.html ./

# CHORUS_HOME est monté en volume depuis l'hôte, uniquement pour les données
# (sandboxes, scripts run.pl générés par sandbox, etc.) — plus pour les
# modules Perl, installés nativement ci-dessus.
ENV CHORUS_HOME=/chorus
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
