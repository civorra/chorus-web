# chorus-web

Interface web pour **Chorus** — moteur de conformité neuro-symbolique
(moteur d'inférence à base de règles + construction de base de connaissances
assistée par IA, voir [`Chorus::Engine`](../engine)).

`chorus-web` permet à un opérateur de piloter le pipeline Chorus depuis un
navigateur plutôt qu'un terminal : import de documents sources
(PDF/DOCX/XLSX/CSV/texte brut), lancement des vérifications de conformité,
suivi en temps réel des opérations longues pilotées par IA (`chorus-feed`,
`chorus-import-project`, `chorus-check`…), et consultation des rapports
générés.

**Licence :** Artistic License 2.0 — même licence que `Chorus::Engine` (voir
[`LICENSE`](./LICENSE)).

## État du projet

Outil interne en phase précoce (MVP), utilisé en parallèle de
`Chorus::Engine` sur des sandboxes réelles. Pas encore un produit packagé et
distribué — voir le suivi de type `WIP.org` (non versionné) pour les
chantiers en cours.

## Vue d'ensemble de l'architecture

- **Backend** — Node.js (Express ≥ 4, Node ≥ 20) : scanne les sandboxes, sert
  les rapports, relaie les opérations longues vers une session headless
  [ECA](https://eca.dev) (`eca-client.js`) pour tout ce qui nécessite le
  pipeline de construction assisté par IA (`chorus-feed`,
  `chorus-import-project`, …).
- **Frontend** — JavaScript pur (sans framework, sans bundler) :
  `chorus-web.html` / `chorus-web.css` / `chorus-web.js`.
- **`chorus/`** — modules de scan et de parsing (découverte des sandboxes,
  lecture des JSON projet, lecture des rapports, résolution du thésaurus).
- **`server/`** — routeurs Express (`routes/`) et fonctions utilitaires
  (`helpers/`, `state.js`) pour l'API HTTP/SSE.

Voir [`INTEGRATION.md`](./INTEGRATION.md) pour le détail de l'installation,
du déploiement et de la configuration.

## Démarrage rapide (Docker — recommandé)

```bash
# 1. Cloner ce dépôt
git clone --branch devel https://github.com/civorra/chorus-web ~/Chorus/web

# 2. Bootstrap : clone chorus-engine + crée .env
cd ~/Chorus/web
./setup.sh

# 3. Build et démarrage
docker compose up --build -d
# → http://localhost:3000
```

Deux services sont démarrés : `eca-server` (agent ECA headless, réseau
interne uniquement) et `chorus` (l'application elle-même, port 3000). Voir
[`INTEGRATION.md`](./INTEGRATION.md) pour les instructions complètes et la
référence de configuration.

## Démarrage rapide (Node.js local, sans Docker)

```bash
npm install
cp .env.example .env
# éditer .env : CHORUS_HOME, SANDBOXES, et optionnellement ANTHROPIC_API_KEY_FILE

node server.js
# → http://localhost:3000
```

Nécessite Node.js ≥ 20. Une instance `eca-server` (ECA headless) doit être
joignable à l'URL configurée dans `ECA_SERVER_URL` pour que les opérations
pilotées par IA fonctionnent ; le scan des sandboxes et la consultation des
rapports fonctionnent indépendamment.

## Organisation du dépôt

```
chorus-web.html / .css / .js   Frontend (JS pur, sans étape de build)
server.js, server/             Application Express backend (routeurs, helpers)
chorus/                        Modules de scan et de parsing des sandboxes
eca-client.js                  Client de l'agent ECA headless (SSE, sessions chat)
auth.js, prompts.js            Authentification, templates de prompts LLM
docker-compose.yml             Déploiement conteneurisé (services : eca-server, chorus)
Dockerfile                     Image du service chorus (Node + Perl + Python + LibreOffice)
Dockerfile.eca                 Image du service eca-server (binaire ECA GraalVM)
chorus-entrypoint.sh           Démarrage conteneur : make install + npm install + node
setup.sh                       Bootstrap hôte : clone engine, création .env
INTEGRATION.md                 Guide d'installation, configuration et dépannage
LICENSE                        Artistic License 2.0
```

## Contribution / conventions

Ce dépôt suit les conventions documentées dans l'`AGENTS.md` de
`Chorus::Engine` pour tout ce qui concerne les skills ECA et le workflow de
développement assisté par ECA, lorsque ce dépôt est utilisé aux côtés du
checkout principal du moteur.
