# Chorus — Guide d'installation

## Prérequis

| Outil | Version minimale | Vérification |
|---|---|---|
| Docker | 24+ | `docker --version` |
| Docker Compose | v2.20+ | `docker compose version` |
| Git | 2+ | `git --version` |

> **Clé API Anthropic (optionnel)** : nécessaire uniquement en mode API pay-per-token.
> En mode OAuth (abonnement Pro/Max), aucune clé n'est requise.

---

## Installation rapide

```bash
# 1. Cloner la webapp (point d'entrée)
#    Le dossier de destination peut être quelconque — setup.sh clone engine
#    dans ~/Chorus/engine par défaut, indépendamment de l'emplacement de web/.
git clone --branch devel https://github.com/civorra/chorus-web ~/Chorus/web

# 2. Bootstrap : clone engine + crée .env
cd ~/Chorus/web
./setup.sh
#    → clone engine dans ~/Chorus/engine (défaut conventionnel)
#    → pour un chemin différent  : CHORUS_ENGINE_HOME=/autre/chemin ./setup.sh
#    → pour un fork engine       : CHORUS_ENGINE_REPO=https://github.com/monfork/Chorus.git ./setup.sh
#    → pour une autre branche    : CHORUS_ENGINE_BRANCH=main ./setup.sh

# 3. Vérifier/éditer .env si nécessaire
#    setup.sh remplit automatiquement les chemins et guide la clé API
nano .env

# 4. Build et démarrage
docker compose up --build -d

# 5. Ouvrir la webapp
open http://localhost:3000
```

`setup.sh` effectue automatiquement :
- Clone de `chorus-engine` dans `~/Chorus/engine` (si absent)
- Création de `.env` depuis `.env.example` avec injection des chemins résolus
- Détection de `~/.config/anthropic/api_key` et configuration de `ANTHROPIC_API_KEY_FILE`

> **Changer de provider LLM sans rebuild :** éditer `.env` (profil A/B/C ci-dessous)
> puis `docker compose restart eca-server`. Le fichier `eca-config.json` est monté en
> volume dans le conteneur et rechargé à chaque démarrage — aucune reconstruction
> d'image requise.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Host : ~/Chorus/                           │
│    engine/    ← repo Chorus Engine (Perl)   │
│    web/       ← ce repo (Node.js)           │
│    sandboxes/ ← données utilisateur         │
└──────────────┬──────────────────────────────┘
               │  volumes
    ┌──────────▼──────────────────────────────┐
    │  Docker Compose                         │
    │                                         │
    │  ┌─────────────┐   ┌─────────────────┐ │
    │  │ eca-server  │   │    chorus       │ │
    │  │ (ECA, :7777)│◄──│ (Node.js, :3000)│ │
    │  │ GraalVM     │   │ + tooling Perl/ │ │
    │  │ headless    │   │   Python/LO     │ │
    │  └─────────────┘   └─────────────────┘ │
    └─────────────────────────────────────────┘
```

**`eca-server`** : agent ECA headless (binaire GraalVM). Charge les skills
depuis `engine/AGENTS.md`. Accessible uniquement depuis `chorus` (réseau interne).

**`chorus`** : serveur Node.js (Express). Expose l'interface web sur le port 3000.
Au démarrage, installe automatiquement les modules `Chorus::*` (Perl) et les
dépendances npm depuis les volumes montés.

---

## Configuration (`.env`)

`setup.sh` crée `.env` depuis `.env.example` et injecte les chemins automatiquement.
Seules les variables ci-dessous nécessitent une attention manuelle :

```bash
# ── Chemins ──────────────────────────────────────────────────────────────────
# Remplis automatiquement par setup.sh — vérifier si les repos sont ailleurs.
CHORUS_HOME=~/Chorus
# CHORUS_ENGINE_HOME=~/Chorus/engine   # défaut : $CHORUS_HOME/engine
# CHORUS_WEB_HOME=~/Chorus/web         # défaut : $CHORUS_HOME/web
# SANDBOXES=~/Chorus/sandboxes         # défaut : $CHORUS_HOME/sandboxes

# ── Authentification LLM ─────────────────────────────────────────────────────
# Profil A — Anthropic Max / Pro (ECA OAuth, recommandé) :
#   Aucune clé API à définir. ECA utilise OAuth via db.transit.json.
#   ANTHROPIC_PROVIDER_TYPE=max   # défaut — ne pas modifier sauf profil B/C

# Profil B — GitHub Copilot Enterprise :
#   Authentifier via Config > Authentification dans la webapp (bouton Copilot).
#   ECA crée son propre db.transit.json dans le conteneur — aucun mount hôte requis.
#   Décommenter et ajuster les valeurs suivantes dans .env :
# ECA_DEFAULT_MODEL=github-copilot/claude-sonnet-5
# ANTHROPIC_PROVIDER_TYPE=oauth
# ECA_MODEL_ARCHITECT=github-copilot/claude-sonnet-5
# ECA_MODEL_CODE=github-copilot/claude-sonnet-5
# ECA_MODEL_FAST=github-copilot/claude-haiku-4-5

# Profil C — Mode API key Anthropic (pay-per-token) :
#   Renseigné automatiquement par setup.sh si ~/.config/anthropic/api_key existe.
#   Sinon, décommenter :
# ANTHROPIC_API_KEY_FILE=~/.config/anthropic/api_key

# ── Modèles LLM (optionnel) ───────────────────────────────────────────────────
# Ces variables contrôlent eca-config.json (monté en volume dans eca-server).
# Changer de modèle = éditer .env + redémarrer eca-server (pas de rebuild).
# ECA_DEFAULT_MODEL=anthropic/claude-sonnet-4-6
# ECA_MODEL_ARCHITECT=anthropic/claude-sonnet-5    # agent architect (thinking étendu)
# ECA_MODEL_CODE=anthropic/claude-sonnet-4-6       # agent code (défaut)
# ECA_MODEL_FAST=anthropic/claude-haiku-4-5-20251001  # agent fast (consultation)

# ── Réseau ────────────────────────────────────────────────────────────────────
PORT=3000
ECA_REMOTE_PASSWORD=changeme-local-dev   # changer en production

# ── OAuth hôte (optionnel) ────────────────────────────────────────────────────
# Monte une session OAuth déjà active sur l'hôte (ex. session ECA Emacs) dans
# le conteneur eca-server, pour éviter une ré-authentification manuelle.
# Non requis : la webapp permet l'authentification native (Config > Auth).
# OAUTH_CREDENTIALS=$HOME/.cache/eca/db.transit.json

# ── Webapp ────────────────────────────────────────────────────────────────────
# Nom du conteneur eca-server (pour /api/auth/reload-eca — restart post-login).
# Défaut : nommage automatique Compose (<project>-eca-server-1).
# Vérifier avec : docker ps --format '{{.Names}}' | grep eca
# ECA_CONTAINER_NAME=web-eca-server-1

# ── OAuth client IDs (avancé) ─────────────────────────────────────────────────
# Les valeurs par défaut (ECA officiel) fonctionnent pour la plupart des usages.
# À surcharger uniquement si vous enregistrez vos propres OAuth Apps.
# ANTHROPIC_OAUTH_CLIENT_ID=...
# ANTHROPIC_OAUTH_SCOPE=...
# COPILOT_OAUTH_CLIENT_ID=...
```

---

## Opérations courantes

```bash
# Démarrer
docker compose up -d

# Arrêter
docker compose down

# Voir les logs
docker compose logs -f chorus
docker compose logs -f eca-server

# Rebuild après modification du Dockerfile
docker compose up --build -d

# Réinitialiser node_modules (si dépendances bloquées)
docker compose down -v && docker compose up -d

# Supprimer les conteneurs orphelins (après renommage de service)
docker compose down --remove-orphans
```

---

## Dépannage

### La webapp s'ouvre mais n'affiche aucun sandbox

`SANDBOXES` pointe vers un répertoire vide ou inexistant.
Vérifier dans `.env` que le chemin correspond bien à un dossier existant sur l'hôte :
```bash
# Exemple : un sandbox nommé "mon-projet"
SANDBOXES=~/Chorus/sandboxes/mon-projet
# ou pour exposer tous les sandboxes :
SANDBOXES=~/Chorus/sandboxes
```

### Port 3000 déjà utilisé

```bash
# Identifier le processus
ss -tlnp | grep 3000
# Changer le port dans .env
PORT=3001
```

### `make install` échoue au démarrage du conteneur

```bash
# Vérifier les logs de l'entrypoint
docker compose logs chorus | grep -A5 "\[entrypoint\]"
# Vérifier que engine/ est bien monté
docker compose exec chorus ls /chorus/engine/Makefile.PL
```

### ECA ne peut pas se connecter à l'API Anthropic / GitHub depuis le conteneur (VPN actif)

**Symptôme :** opérations IA en erreur (`ECONNREFUSED`, timeout TLS) dès qu'un VPN
d'entreprise est actif sur l'hôte, alors qu'elles fonctionnent sans VPN.

**Cause :** un ancien correctif figeait `dns: [1.1.1.1, 8.8.8.8]` dans
`docker-compose.yml`. Les VPN avec split-tunnel filtrent le port 53 vers les
résolveurs publics — les conteneurs perdent alors toute résolution DNS.

**Solution (déjà appliquée) :** ne pas définir `dns:` dans `docker-compose.yml`. Les
conteneurs héritent du résolveur de l'hôte, qui bascule correctement entre DNS normal
et DNS VPN selon le contexte réseau actif.

> Si vous avez forké le `docker-compose.yml` et ajouté `dns:` manuellement,
> supprimez cette directive pour retrouver la compatibilité VPN.

---

### Rebuild total (from scratch)

```bash
docker compose down --remove-orphans -v   # supprime conteneurs + volumes nommés
docker compose down --rmi local           # supprime images locales
docker compose up --build -d
```

### Tester un bootstrap complet (simuler host vierge)

```bash
mv ~/Chorus/engine ~/Chorus/engine.bak
docker compose down -v --rmi local
./setup.sh                                # re-clone engine
docker compose up --build -d
# Restaurer l'original après test :
# rm -rf ~/Chorus/engine && mv ~/Chorus/engine.bak ~/Chorus/engine
```
