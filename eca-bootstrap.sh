#!/bin/sh
# Envoie la poignée de main JSON-RPC "initialize" / "initialized" requise par
# ECA (protocole inspiré de LSP, cf. eca.dev/protocol/) sur son stdin, puis
# garde le pipe ouvert indéfiniment (sinon eca sort sur EOF). Sans ce
# handshake, le serveur HTTP/SSE "remote" (remote.enabled: true) ne
# s'active jamais — confirmé par test en session (process restait inerte,
# aucun port ouvert).
set -e

# Authentification Anthropic — deux modes :
#
#  Mode OAuth (prioritaire) : si les credentials ECA sont montés depuis l'hôte
#    (/root/.config/eca/credentials), ECA utilise l'abonnement Pro/Max via OAuth.
#    Dans ce cas ANTHROPIC_API_KEY NE DOIT PAS être définie — elle écraserait
#    OAuth et basculerait ECA en mode pay-per-token.
#
#  Mode API key (fallback) : si les credentials OAuth sont absents ET qu'un
#    secret Docker est disponible (/run/secrets/anthropic_api_key), on injecte
#    la clé pour maintenir la compatibilité (dev local sans session Pro/Max).
if [ -f /root/.cache/eca/db.transit.json ]; then
  echo "[eca-bootstrap] Credentials OAuth détectés (db.transit.json) — mode Pro/Max"
elif [ -f /run/secrets/anthropic_api_key ]; then
  export ANTHROPIC_API_KEY="$(cat /run/secrets/anthropic_api_key)"
  echo "[eca-bootstrap] Credentials OAuth absents — fallback API key injectée"
else
  echo "[eca-bootstrap] ⚠ Aucune authentification disponible (ni OAuth ni API key)"
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
