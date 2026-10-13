#!/bin/sh
# Envoie la poignée de main JSON-RPC "initialize" / "initialized" requise par
# ECA (protocole inspiré de LSP, cf. eca.dev/protocol/) sur son stdin, puis
# garde le pipe ouvert indéfiniment (sinon eca sort sur EOF). Sans ce
# handshake, le serveur HTTP/SSE "remote" (remote.enabled: true) ne
# s'active jamais — confirmé par test en session (process restait inerte,
# aucun port ouvert).
set -e

# Authentification LLM — deux modes :
#
#  Mode OAuth (prioritaire) : si le credential store ECA est monté depuis l'hôte
#    (~/.cache/eca/db.transit.json), ECA utilise le provider configuré dans
#    config.json (defaultModel) via OAuth — ex : anthropic/Pro/Max ou github-copilot.
#    Dans ce cas ANTHROPIC_API_KEY NE DOIT PAS être définie — elle écraserait
#    OAuth et basculerait ECA en mode pay-per-token.
#
#  Mode API key (fallback) : si le credential store OAuth est absent ET qu'un
#    secret Docker est disponible (/run/secrets/anthropic_api_key), on injecte
#    la clé pour maintenir la compatibilité (dev local sans session OAuth).
CREDS_FILE="/root/.cache/eca/db.transit.json"
WEBAPP_AUTH="${CHORUS_HOME:-/chorus}/.webapp-auth.json"

# Détecte les providers présents dans le credential store Transit JSON d'ECA.
# Les clés providers apparaissent comme strings JSON ("anthropic", "github-copilot", etc.)
# Utilise uniquement grep (POSIX pur, compatible Alpine/Debian minimal).
detect_providers() {
  _f="$1"; _p=""
  grep -q '"anthropic"' "$_f" && grep -qE 'api-key|refresh-token' "$_f" \
    && _p="${_p}anthropic "
  grep -qE '"github-copilot"|"copilot"' "$_f" \
    && _p="${_p}github-copilot "
  echo "${_p:-unknown}"
}

if [ -f "$CREDS_FILE" ]; then
  PROVIDERS=$(detect_providers "$CREDS_FILE")
  echo "[eca-bootstrap] Credentials OAuth détectés (db.transit.json) — providers: ${PROVIDERS}"
  # Pas d'injection ANTHROPIC_API_KEY : ECA route vers le provider via config.json (defaultModel).
elif [ -f "$WEBAPP_AUTH" ]; then
  echo "[eca-bootstrap] Credentials webapp détectés (.webapp-auth.json)"
  # Extraction POSIX pure (grep/sed), sans dépendance python3 — cette image
  # (Dockerfile.eca, debian:bookworm-slim minimal) n'installe QUE
  # curl/ca-certificates/unzip, contrairement à Dockerfile de chorus-web.
  # Un appel `command -v python3` échouait silencieusement ici (binaire
  # absent), laissant API_KEY/COPILOT_TOKEN vides en permanence, peu
  # importe le contenu réel de .webapp-auth.json — bug découvert en
  # session ECA (2026-10-13) en testant le scénario de fallback webapp
  # sans credentials OAuth natifs. La version précédente (python3 -c)
  # n'a donc, de fait, jamais pu extraire un token dans ce conteneur.
  #
  # Approche : extraire le bloc JSON du provider ciblé via grep -o sur un
  # pattern non-gourmand bloc-par-clé, puis sed pour isoler la valeur du
  # champ voulu. Suffisant pour le JSON plat (non nesté, une seule ligne
  # ou multi-lignes simples) produit par server/routes/*.js côté webapp.
  extract_json_field() {
    # $1 = fichier ; $2 = nom du bloc provider (ex: "anthropic") ;
    # $3 = nom du champ (ex: "api_key") — retourne la valeur ou vide.
    _file="$1"; _provider="$2"; _field="$3"
    awk -v provider="\"$_provider\"" -v field="\"$_field\"" '
      index($0, provider) { in_block=1 }
      in_block && index($0, "}") { in_block=0 }
      in_block && index($0, field) {
        line=$0
        sub(/^[^:]*:[ \t]*"/, "", line)
        sub(/".*$/, "", line)
        print line
        exit
      }
    ' "$_file"
  }

  API_KEY=$(extract_json_field "$WEBAPP_AUTH" "anthropic" "api_key")
  [ -z "$API_KEY" ] && API_KEY=$(extract_json_field "$WEBAPP_AUTH" "anthropic" "access_token")
  if [ -n "$API_KEY" ]; then
    export ANTHROPIC_API_KEY="$API_KEY"
    echo "[eca-bootstrap] ANTHROPIC_API_KEY injectée depuis .webapp-auth.json"
  fi

  COPILOT_TOKEN=$(extract_json_field "$WEBAPP_AUTH" "github-copilot" "access_token")
  if [ -n "$COPILOT_TOKEN" ]; then
    export GITHUB_COPILOT_TOKEN="$COPILOT_TOKEN"
    echo "[eca-bootstrap] GITHUB_COPILOT_TOKEN injectée depuis .webapp-auth.json"
  fi
  if [ -z "$API_KEY" ] && [ -z "$COPILOT_TOKEN" ]; then
    echo "[eca-bootstrap] ⚠ .webapp-auth.json présent mais aucun token exploitable"
  fi
elif [ -f /run/secrets/anthropic_api_key ]; then
  export ANTHROPIC_API_KEY="$(cat /run/secrets/anthropic_api_key)"
  echo "[eca-bootstrap] Credentials OAuth absents — fallback API key injectée"
else
  echo "[eca-bootstrap] ⚠ Aucune authentification disponible (ni OAuth ni API key ni webapp)"
fi

send_message() {
  payload="$1"
  len=$(printf '%s' "$payload" | wc -c)
  printf 'Content-Length: %s\r\n\r\n%s' "$len" "$payload"
}

# Deux workspace folders :
# - "chorus-engine" (/chorus/Engine) en premier, pour que ECA auto-charge
#   Engine/AGENTS.md (skills Chorus) au démarrage de chaque session
#   (sinon seul le skill intégré "eca-info" apparaît à la commande "skills").
# - "chorus" (/chorus, racine) en second, pour garder l'accès complet aux
#   outils fichiers sur /chorus/sandboxes/, /chorus/chorus-web/, etc.
#   (sandboxes/ est un sibling de Engine/, pas un sous-dossier — voir
#   arborescence réelle du dépôt).
INIT_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"clientInfo":{"name":"eca-bootstrap","version":"1.0.0"},"capabilities":{},"workspaceFolders":[{"uri":"file:///chorus/Engine","name":"chorus-engine"},{"uri":"file:///chorus","name":"chorus"}]}}'
INITIALIZED_NOTIF='{"jsonrpc":"2.0","method":"initialized","params":{}}'

{
  send_message "$INIT_REQUEST"
  sleep 2
  send_message "$INITIALIZED_NOTIF"
  # Garde stdin ouvert indéfiniment (jamais d'EOF) pour que eca reste en vie.
  tail -f /dev/null
} | exec eca server --config-file /etc/eca/config.json --log-level info
