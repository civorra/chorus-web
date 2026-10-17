#!/bin/sh
# chorus-entrypoint.sh — lancé au démarrage du conteneur chorus.
# 1. Installe les modules Perl Chorus::* depuis le volume /chorus/engine.
# 2. Installe les dépendances npm depuis /chorus/web (node_modules_chorus).
# 3. Lance node server.js.
set -e

# ── 1. Chorus::* (Perl) ──────────────────────────────────────────────────────
# Exécuté à chaque démarrage pour rester synchronisé avec le code monté.
# Coût : ~10s. Skip si le volume engine n'est pas encore disponible.
if [ -f /chorus/engine/Makefile.PL ]; then
  echo "[entrypoint] Installing Chorus::* modules from /chorus/engine…"
  cd /chorus/engine
  perl Makefile.PL INSTALLDIRS=site > /dev/null 2>&1
  make > /dev/null 2>&1
  make install > /dev/null 2>&1
  echo "[entrypoint] Chorus::* modules installed."
else
  echo "[entrypoint] WARNING: /chorus/engine/Makefile.PL not found — Chorus::* modules NOT installed."
fi

# ── 2. npm dependencies ──────────────────────────────────────────────────────
# node_modules_chorus est un volume nommé monté sur /chorus/web/node_modules.
# Au premier démarrage il est vide → npm install le remplit (~30s).
# Les démarrages suivants sont instantanés (volume persisté).
if [ ! -f /chorus/web/node_modules/.package-lock.json ] && [ -f /chorus/web/package.json ]; then
  echo "[entrypoint] Installing npm dependencies…"
  cd /chorus/web
  npm install --omit=dev
  echo "[entrypoint] npm dependencies installed."
fi

# ── 3. Démarrage du serveur ───────────────────────────────────────────────────
echo "[entrypoint] Starting chorus server…"
cd /chorus/web
exec node server.js
