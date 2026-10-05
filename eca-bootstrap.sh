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
  # Extraire l'api_key Anthropic depuis le JSON simple de la webapp
  API_KEY=""
  if command -v python3 >/dev/null 2>&1; then
    API_KEY=$(python3 -c "
import json, sys
try:
    d = json.load(open('$WEBAPP_AUTH'))
    a = d.get('anthropic', {})
    print(a.get('api_key', a.get('access_token', '')), end='')
except Exception:
    pass
" 2>/dev/null)
  fi
  if [ -n "$API_KEY" ]; then
    export ANTHROPIC_API_KEY="$API_KEY"
    echo "[eca-bootstrap] ANTHROPIC_API_KEY injectée depuis .webapp-auth.json"
  else
    echo "[eca-bootstrap] ⚠ .webapp-auth.json présent mais api_key introuvable"
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

INIT_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"clientInfo":{"name":"eca-bootstrap","version":"1.0.0"},"capabilities":{},"workspaceFolders":[{"uri":"file:///chorus","name":"chorus"}]}}'
INITIALIZED_NOTIF='{"jsonrpc":"2.0","method":"initialized","params":{}}'

{
  send_message "$INIT_REQUEST"
  sleep 2
  send_message "$INITIALIZED_NOTIF"
  # Garde stdin ouvert indéfiniment (jamais d'EOF) pour que eca reste en vie.
  tail -f /dev/null
} | exec eca server --config-file /etc/eca/config.json --log-level info
