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
git clone --branch devel https://github.com/maelink/chorus-web ~/Chorus/web

# 2. Bootstrap : clone engine + crée .env
cd ~/Chorus/web
./setup.sh
#    → clone engine dans ~/Chorus/engine (défaut conventionnel)
#    → pour un chemin différent : CHORUS_ENGINE_HOME=/autre/chemin ./setup.sh

# 3. Vérifier/éditer .env si nécessaire
#    (setup.sh guide la configuration — voir § Configuration ci-dessous)
nano .env

# 4. Build et démarrage
docker compose up --build -d

# 5. Ouvrir la webapp
open http://localhost:3000
```

`setup.sh` effectue automatiquement :
- Clone de `chorus-engine` dans `~/Chorus/engine` (si absent)
- Création de `.env` depuis `.env.example`
- Détection et configuration de `ANTHROPIC_API_KEY_FILE` si `~/.config/anthropic/api_key` existe

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

Après `./setup.sh`, éditer `.env` pour ajuster :

```bash
# ── Chemins (remplis automatiquement par setup.sh) ──────────────────────────
CHORUS_HOME=/home/<user>/Chorus
# CHORUS_ENGINE_HOME=/home/<user>/Chorus/engine   # défaut : $CHORUS_HOME/engine
# CHORUS_WEB_HOME=/home/<user>/Chorus/web         # défaut : $CHORUS_HOME/web
# SANDBOXES=/home/<user>/Chorus/sandboxes/mon-sandbox  # défaut : $CHORUS_HOME/sandboxes

# ── Authentification LLM ────────────────────────────────────────────────────
# Option A — Mode OAuth (abonnement Pro/Max, recommandé) :
#   Aucune variable requise. ECA utilise ses credentials OAuth natifs.

# Option B — Mode API key :
ANTHROPIC_API_KEY_FILE=/home/<user>/.config/anthropic/api_key

# ── Réseau ───────────────────────────────────────────────────────────────────
PORT=3000
ECA_REMOTE_PASSWORD=changeme-local-dev   # changer en production
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
Vérifier dans `.env` :
```bash
# Chemin vu depuis le conteneur — doit correspondre au volume monté
SANDBOXES=/chorus/sandboxes/<nom-du-sandbox>
```

### Port 3000 déjà utilisé

```bash
# Identifier le processus
ss -tlnp | grep 3000
# Changer le port dans .env + docker-compose.yml
PORT=3001
```

### `cpanm` ou `make install` échoue au démarrage du conteneur

```bash
# Vérifier les logs de l'entrypoint
docker compose logs chorus | grep -A5 entrypoint
# Si engine/ n'est pas monté correctement :
ls -la ~/Chorus/engine/Makefile.PL
```

### Rebuild total (from scratch)

```bash
docker compose down --remove-orphans -v   # supprime volumes nommés
docker compose down --rmi local           # supprime images locales
docker compose up --build -d
```

### Tester un bootstrap complet (simuler host vierge)

```bash
mv ~/Chorus/engine ~/Chorus/engine.bak
docker compose down -v --rmi local
./setup.sh                        # re-clone engine
docker compose up --build -d
# Restaurer l'original après test :
# rm -rf ~/Chorus/engine && mv ~/Chorus/engine.bak ~/Chorus/engine
```
