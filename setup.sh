#!/usr/bin/env bash
# setup.sh — Bootstrap sur host vierge.
# À exécuter UNE SEULE FOIS après avoir cloné ce repo (web/).
#
# Ce script clone le repo chorus-engine dans CHORUS_ENGINE_HOME si le
# dossier est absent ou ne contient pas encore de repo git.
#
# Usage :
#   git clone <url-web> ~/Chorus/web
#   cd ~/Chorus/web
#   ./setup.sh
#   docker compose up -d
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Chargement de .env si présent ────────────────────────────────────────────
if [ -f "$SCRIPT_DIR/.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

# ── Valeurs par défaut ───────────────────────────────────────────────────────
CHORUS_HOME="${CHORUS_HOME:-$(dirname "$SCRIPT_DIR")}"
CHORUS_ENGINE_HOME="${CHORUS_ENGINE_HOME:-$CHORUS_HOME/engine}"
CHORUS_ENGINE_REPO="${CHORUS_ENGINE_REPO:-https://github.com/maelink/Chorus-Engine.git}"
CHORUS_ENGINE_BRANCH="${CHORUS_ENGINE_BRANCH:-devel}"

echo "=== Chorus bootstrap ==="
echo "  CHORUS_HOME        : $CHORUS_HOME"
echo "  CHORUS_ENGINE_HOME : $CHORUS_ENGINE_HOME"

# ── Clone engine si absent ────────────────────────────────────────────────────
if [ -d "$CHORUS_ENGINE_HOME/.git" ]; then
  echo "  engine repo        : ✅ déjà présent ($CHORUS_ENGINE_HOME)"
else
  echo "  engine repo        : clonage depuis $CHORUS_ENGINE_REPO (branche $CHORUS_ENGINE_BRANCH)…"
  git clone --branch "$CHORUS_ENGINE_BRANCH" "$CHORUS_ENGINE_REPO" "$CHORUS_ENGINE_HOME"
  echo "  engine repo        : ✅ cloné"
fi

# ── Création de .env si absent ────────────────────────────────────────────────
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo ""
  echo "  Création de .env depuis .env.example…"
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  # Injection des chemins résolus
  sed -i "s|CHORUS_HOME=.*|CHORUS_HOME=$CHORUS_HOME|" "$SCRIPT_DIR/.env"
  sed -i "s|CHORUS_ENGINE_HOME=.*|CHORUS_ENGINE_HOME=$CHORUS_ENGINE_HOME|" "$SCRIPT_DIR/.env"
  sed -i "s|CHORUS_WEB_HOME=.*|CHORUS_WEB_HOME=$SCRIPT_DIR|" "$SCRIPT_DIR/.env"
  echo "  .env               : ✅ créé — pensez à renseigner les secrets (ANTHROPIC_API_KEY_FILE, etc.)"
fi

echo ""
echo "✅ Setup terminé. Lancez :"
echo "   docker compose up --build -d"
