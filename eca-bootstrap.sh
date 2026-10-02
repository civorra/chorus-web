#!/bin/sh
# Envoie la poignée de main JSON-RPC "initialize" / "initialized" requise par
# ECA (protocole inspiré de LSP, cf. eca.dev/protocol/) sur son stdin, puis
# garde le pipe ouvert indéfiniment (sinon eca sort sur EOF). Sans ce
# handshake, le serveur HTTP/SSE "remote" (remote.enabled: true) ne
# s'active jamais — confirmé par test en session (process restait inerte,
# aucun port ouvert).
set -e

# Clé Anthropic via secret Docker Compose (/run/secrets/anthropic_api_key),
# jamais en variable d'env de conteneur — repli sur ANTHROPIC_API_KEY si le
# secret est absent (dev local sans secrets configurés).
if [ -f /run/secrets/anthropic_api_key ]; then
  export ANTHROPIC_API_KEY="$(cat /run/secrets/anthropic_api_key)"
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
