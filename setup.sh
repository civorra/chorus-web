#!/usr/bin/env bash
# setup.sh — Bootstrap sur host vierge.
# À exécuter UNE SEULE FOIS après avoir cloné ce repo (web/).
#
# Ce script :
#   1. Clone chorus-engine dans CHORUS_ENGINE_HOME si absent.
#   2. Crée .env depuis .env.example si absent.
#   3. Guide la configuration de la clé API Anthropic.
#
# Usage :
#   git clone <url-web> ~/Chorus/web
#   cd ~/Chorus/web
#   ./setup.sh
#   docker compose up --build -d
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Chargement de .env si déjà présent ───────────────────────────────────────
if [ -f "$SCRIPT_DIR/.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

# ── Valeurs par défaut ───────────────────────────────────────────────────────
# CHORUS_HOME : dossier parent conventionnel qui contiendra engine/ et web/.
# Défaut : ~/Chorus (indépendant de l'endroit où web/ est cloné).
# Surcharger dans .env ou via : CHORUS_HOME=/autre/chemin ./setup.sh
CHORUS_HOME="${CHORUS_HOME:-$HOME/Chorus}"
CHORUS_ENGINE_HOME="${CHORUS_ENGINE_HOME:-$CHORUS_HOME/engine}"
CHORUS_ENGINE_REPO="${CHORUS_ENGINE_REPO:-https://github.com/maelink/Chorus-Engine.git}"
CHORUS_ENGINE_BRANCH="${CHORUS_ENGINE_BRANCH:-devel}"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║         Chorus — Bootstrap setup         ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  web/    (ce repo)  : $SCRIPT_DIR"
echo "  engine/ (à cloner) : $CHORUS_ENGINE_HOME"
echo "  CHORUS_HOME        : $CHORUS_HOME"
echo ""

# ── Confirmation si engine irait ailleurs que ~/Chorus/engine ────────────────
if [ "$CHORUS_ENGINE_HOME" != "$HOME/Chorus/engine" ] && [ ! -d "$CHORUS_ENGINE_HOME/.git" ]; then
  echo "  ⚠️  engine/ sera cloné dans : $CHORUS_ENGINE_HOME"
  printf "  Confirmer ? [o/N] "
  read -r confirm
  if [[ ! "$confirm" =~ ^[oOyY]$ ]]; then
    echo ""
    echo "  Annulé. Pour choisir un autre chemin :"
    echo "  CHORUS_ENGINE_HOME=/mon/chemin/engine ./setup.sh"
    exit 0
  fi
fi
echo ""

# ── 1. Clone engine si absent ─────────────────────────────────────────────────
if [ -d "$CHORUS_ENGINE_HOME/.git" ]; then
  echo "  [1/3] engine repo  : ✅ déjà présent"
else
  echo "  [1/3] engine repo  : clonage depuis $CHORUS_ENGINE_REPO (branche $CHORUS_ENGINE_BRANCH)…"
  git clone --branch "$CHORUS_ENGINE_BRANCH" "$CHORUS_ENGINE_REPO" "$CHORUS_ENGINE_HOME"
  echo "  [1/3] engine repo  : ✅ cloné dans $CHORUS_ENGINE_HOME"
fi

# ── 2. Création de .env si absent ────────────────────────────────────────────
if [ -f "$SCRIPT_DIR/.env" ]; then
  echo "  [2/3] .env         : ✅ déjà présent"
else
  echo "  [2/3] .env         : création depuis .env.example…"
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  # Injection des chemins résolus
  sed -i "s|^CHORUS_HOME=.*|CHORUS_HOME=$CHORUS_HOME|" "$SCRIPT_DIR/.env"
  sed -i "s|^# CHORUS_ENGINE_HOME=.*|CHORUS_ENGINE_HOME=$CHORUS_ENGINE_HOME|" "$SCRIPT_DIR/.env"
  sed -i "s|^# CHORUS_WEB_HOME=.*|CHORUS_WEB_HOME=$SCRIPT_DIR|" "$SCRIPT_DIR/.env"
  echo "  [2/3] .env         : ✅ créé"
fi

# ── 3. Clé API Anthropic ─────────────────────────────────────────────────────
DEFAULT_KEY_FILE="$HOME/.config/anthropic/api_key"
CURRENT_KEY_FILE="${ANTHROPIC_API_KEY_FILE:-}"

echo ""
if [ -n "$CURRENT_KEY_FILE" ] && [ -f "$CURRENT_KEY_FILE" ]; then
  echo "  [3/3] API key      : ✅ configurée ($CURRENT_KEY_FILE)"
elif [ -f "$DEFAULT_KEY_FILE" ]; then
  echo "  [3/3] API key      : fichier trouvé à l'emplacement par défaut."
  # Injection automatique dans .env si pas encore défini
  if ! grep -q "^ANTHROPIC_API_KEY_FILE=" "$SCRIPT_DIR/.env"; then
    echo "ANTHROPIC_API_KEY_FILE=$DEFAULT_KEY_FILE" >> "$SCRIPT_DIR/.env"
  fi
  echo "                       ✅ ANTHROPIC_API_KEY_FILE=$DEFAULT_KEY_FILE ajouté dans .env"
else
  echo "  [3/3] API key      : ⚠️  fichier de clé API Anthropic non trouvé."
  echo ""
  echo "         Deux options :"
  echo "         A) Mode API key  : créez ~/.config/anthropic/api_key avec votre clé,"
  echo "            puis ajoutez dans .env :"
  echo "            ANTHROPIC_API_KEY_FILE=$DEFAULT_KEY_FILE"
  echo ""
  echo "         B) Mode OAuth    : aucune clé nécessaire si vous utilisez ECA via"
  echo "            un abonnement Anthropic Pro/Max — laissez ANTHROPIC_API_KEY_FILE"
  echo "            non défini (le conteneur démarre sans secret, OAuth seul actif)."
fi

# ── Résumé final ──────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Setup terminé."
echo ""
echo "  Prochaine étape :"
echo "  → Vérifiez/éditez .env si nécessaire"
echo "  → Lancez : docker compose up --build -d"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
