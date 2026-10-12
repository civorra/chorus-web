# Intégration frontend MVP0

Ce document décrit les **3 adaptations** à faire dans `chorus-web.html`
pour le brancher sur le serveur Node.js MVP0.

---

## 1. Initialisation — remplacer les données JS hardcodées

Au chargement de la page, appeler `/api/scan` et injecter les résultats
à la place des constantes `SANDBOXES` / `PROJECTS` / `CONTEXTS`.

```js
// Ajouter en haut de <script>, avant toute utilisation de SANDBOXES
const API = 'http://localhost:3000'; // adapter si le serveur est distant

async function initFromServer() {
  try {
    const r = await fetch(`${API}/api/scan`);
    if (!r.ok) throw new Error(await r.text());
    const { sandboxes } = await r.json();

    // Remplacer les données simulées
    SANDBOXES.length = 0;
    Object.keys(PROJECTS).forEach(k => delete PROJECTS[k]);
    Object.keys(CONTEXTS).forEach(k => delete CONTEXTS[k]);

    for (const sb of sandboxes) {
      SANDBOXES.push({
        id:       sb.id,
        name:     sb.name,
        standard: sb.standard || sb.norm,
        desc:     sb.desc || '',
      });
      CONTEXTS[sb.id] = sb.contexts || [];
      PROJECTS[sb.id] = sb.projects.map(p => ({
        id:         p.id,
        name:       p.name,
        state:      p.state,       // 'imported' | 'available'
        frames:     p.frames || 0,
        compliance: p.compliance,  // null si pas encore traité
        verdict:    p.verdict,
        context:    'default',
        type:       'pdf',
        reports:    p.reportFile ? [{
          icon:  '📋',
          kind:  'run',
          label: p.reportFile,
          desc:  `${p.verdict || '?'} · ${p.reportData?.conformes || 0}/${p.frames} CONFORMES`,
          path:  `sandboxes/${sb.id}/workspace/${p.id}/${p.reportFile}`,
          date:  p.reportData?.date || new Date().toISOString().slice(0,10),
        }] : [],
      }));
    }

    // Ré-afficher
    renderSandboxList();
    if (SANDBOXES.length > 0) selectSandbox(SANDBOXES[0].id);

  } catch (err) {
    console.warn('Serveur MVP0 non disponible — mode simulation', err.message);
    // Silencieux : le PoC continue avec les données JS simulées
  }
}

// Appeler au démarrage (remplacer ou compléter l'appel existant à initApp())
document.addEventListener('DOMContentLoaded', () => {
  initApp();       // initialisation skin, etc.
  initFromServer(); // surcharge avec données réelles si serveur dispo
});
```

---

## 2. Lancement du pipeline — brancher `run.pl` réel

Dans `runPipeline()`, remplacer la simulation par un appel SSE réel :

```js
async function runPipeline() {
  if (pipelineRunning || !currentProject || !currentSandbox) return;
  pipelineRunning = true;
  // ... reset UI existant ...

  const url = `${API}/api/sandboxes/${currentSandbox.id}/projects/${currentProject.id}/run`;

  const es = new EventSource(url); // GET avec SSE
  // Note : pour POST, utiliser fetch + ReadableStream (voir ci-dessous)

  es.addEventListener('log', e => {
    const { line, level } = JSON.parse(e.data);
    appendLog(line, level); // fonction existante du PoC
  });

  es.addEventListener('done', e => {
    const { reportFile, reportData } = JSON.parse(e.data);
    es.close();
    // Mettre à jour currentProject.reports avec le vrai rapport
    if (reportFile) {
      _lastReports = [{
        icon:  '📋',
        label: reportFile,
        desc:  `${reportData?.verdict} · ${reportData?.conformes}/${reportData?.totalFrames} CONFORMES`,
        path:  `sandboxes/${currentSandbox.id}/workspace/${currentProject.id}/${reportFile}`,
        _reportData: reportData, // pour la modale rapport
      }];
      renderReportsList(_lastReports);
    }
    finishPipeline(currentProject, `sandboxes/${currentSandbox.id}/workspace`, 'pipeline-run-btn');
  });

  es.addEventListener('error', e => {
    const { message } = JSON.parse(e.data);
    es.close();
    appendLog(`❌ ${message}`, 'error');
    pipelineRunning = false;
  });
}

// Pour un POST SSE (run.pl nécessite POST) :
async function ssePost(url, body, onLog, onDone, onError) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const eMatch = part.match(/^event: (\w+)/m);
      const dMatch = part.match(/^data: (.+)/m);
      if (!eMatch || !dMatch) continue;
      const data = JSON.parse(dMatch[1]);
      if      (eMatch[1] === 'log')   onLog(data);
      else if (eMatch[1] === 'done')  onDone(data);
      else if (eMatch[1] === 'error') onError(data);
    }
  }
}
```

---

## 3. Brancher chorus-check sur le LLM réel

Dans `runChorusCheckAction(action)`, remplacer la simulation par :

```js
async function runChorusCheckAction(action) {
  if (pipelineRunning || !currentProject || !currentSandbox) return;

  const ecaWrap = document.getElementById('eca-wrap');
  ecaWrap.style.display = 'block';
  document.getElementById('pipeline-log').innerHTML = '';

  const url = `${API}/api/sandboxes/${currentSandbox.id}/projects/${currentProject.id}/check?action=${action}`;

  // EventSource pour GET SSE
  const es = new EventSource(url);

  es.addEventListener('log', e => {
    const { line } = JSON.parse(e.data);
    appendLog(line);
  });

  es.addEventListener('chunk', e => {
    const { text } = JSON.parse(e.data);
    // Ajouter le texte au terminal ECA existant
    const log = document.getElementById('pipeline-log');
    log.textContent += text;
    log.scrollTop = log.scrollHeight;
  });

  es.addEventListener('done', e => {
    const { filename } = JSON.parse(e.data);
    es.close();
    // Afficher le trigger ECA session
    const trigger = document.getElementById('eca-session-trigger');
    if (trigger) trigger.style.display = 'block';
    // Ajouter le rapport généré à la liste
    if (filename && _lastReports) {
      _lastReports.push({
        icon:  action === 'summary' ? '📄' : '🔍',
        label: filename,
        desc:  action === 'summary' ? 'Synthèse LLM — 1 page' : 'Explications règle par règle',
        path:  `sandboxes/${currentSandbox.id}/workspace/${currentProject.id}/${filename}`,
      });
      renderReportsList(_lastReports);
    }
  });

  es.addEventListener('error', e => {
    const { message } = JSON.parse(e.data);
    es.close();
    appendLog(`❌ ${message}`, 'error');
  });
}
```

---

---

## 4. Bouton chorus-complete-report sur les rapports --explain

Le PoC affiche un bouton **📝 Complete** sur chaque rapport de type `--explain` dans la liste des rapports.
Pour le brancher sur le serveur MVP0, modifier `runCompleteReport` dans `chorus-web.html` :

```js
async function runCompleteReport(reportIndex, _directReport) {
  // ... (setup identique à runChorusCheckAction) ...

  const report = _directReport || (window._lastReports || [])[reportIndex];
  const url = `${API}/api/sandboxes/${currentSandbox.id}/projects/${currentProject.id}/check`
            + `?action=complete-report&input=${encodeURIComponent(report.label)}`;

  const es = new EventSource(url);

  es.addEventListener('log', e => {
    const { line } = JSON.parse(e.data);
    appendLog(line);
  });

  es.addEventListener('chunk', e => {
    const { text } = JSON.parse(e.data);
    const log = document.getElementById('pipeline-log');
    log.textContent += text;
    log.scrollTop = log.scrollHeight;
  });

  es.addEventListener('done', e => {
    const { filename } = JSON.parse(e.data);
    es.close();
    if (filename) {
      const allReports = [...(window._lastReports || [])];
      const srcIdx = allReports.findIndex(r => r.label === report.label);
      const newReport = {
        icon:  '📝',
        kind:  'complete-report',
        label: filename,
        desc:  `Rapport complet · issu de ${report.label}`,
        path:  `sandboxes/${currentSandbox.id}/workspace/${currentProject.id}/${filename}`,
        date:  new Date().toISOString().slice(0, 10),
        run:   'chorus-complete-report',
      };
      if (srcIdx >= 0) allReports.splice(srcIdx + 1, 0, newReport);
      else allReports.push(newReport);
      renderReportsList(allReports);
    }
  });

  es.addEventListener('error', e => {
    const { message } = JSON.parse(e.data);
    es.close();
    appendLog(`❌ ${message}`, 'error');
  });
}
```

---

## Mode hybride (recommandé)

Le PoC détecte automatiquement si le serveur est disponible au démarrage.
Si `/api/scan` répond → mode réel.
Sinon → mode simulation (comportement actuel du PoC, inchangé).

Cela permet de continuer à utiliser le PoC standalone (sans serveur)
pour les démos, tout en ayant le mode réel quand le serveur tourne.

---

## Commandes de démarrage

```bash
# Installer les dépendances
npm install

# Configurer
cp .env.example .env
# Éditer .env : CHORUS_HOME, ANTHROPIC_API_KEY

# Démarrer
node server.js
# → http://localhost:3000
```

---

## Authentification — deux couches indépendantes

### Couche 1 — webapp → eca-server (Bearer token)

`eca-client.js` envoie `Authorization: Bearer <ECA_REMOTE_PASSWORD>` à chaque
requête vers `eca-server`. Ce mot de passe doit être **identique** dans les
deux services Docker :

```yaml
# docker-compose.yml — les deux services doivent partager la même valeur
eca-server:
  environment:
    - ECA_REMOTE_PASSWORD=${ECA_REMOTE_PASSWORD}   # lu par eca-config.json
chorus-web:
  environment:
    - ECA_REMOTE_PASSWORD=${ECA_REMOTE_PASSWORD}   # lu par eca-client.js
```

`eca-config.json` déclare `"password": "${env:ECA_REMOTE_PASSWORD}"`.

> ⚠️ **Valeur par défaut `changeme-local-dev`** — à remplacer impérativement
> en production. Sans `.env`, les deux services utilisent cette valeur par défaut,
> ce qui fonctionne en dev local mais est insécurisé en exposition publique.
>
> **Indépendant d'Emacs** : ce token n'a aucune relation avec une session Emacs.

---

### Couche 2 — eca-server → LLM (credentials Anthropic / GitHub Copilot)

`eca-bootstrap.sh` applique la chaîne de priorité suivante au démarrage du
container `eca-server` :

| Priorité | Source | Description |
|---|---|---|
| 1 (haute) | `db.transit.json` | OAuth ECA natif — credentials de la session Emacs Pro/Max montés via `OAUTH_CREDENTIALS` |
| 2 | `.webapp-auth.json` | Credentials gérés par la WEBAPP — OAuth PKCE (Anthropic) ou Device Flow (GitHub Copilot) initiés depuis Settings > Authentification |
| 3 (fallback) | Docker secret | `/run/secrets/anthropic_api_key` — API key Anthropic injectée via `ANTHROPIC_API_KEY_FILE` dans `docker-compose.yml` |

**`OAUTH_CREDENTIALS` est optionnel.** Si la variable est absente ou si
`db.transit.json` n'existe pas, `eca-bootstrap.sh` passe automatiquement à la
priorité 2 (`.webapp-auth.json`). La WEBAPP peut donc fonctionner **sans
session Emacs active** dès lors qu'une authentification a été réalisée via
Settings > Authentification (OAuth PKCE ou clé API manuelle).

#### Workflow webapp-native (sans Emacs)

1. Ouvrir Settings (⚙️) > Authentification
2. Cliquer **🔐 Anthropic** → suivre le flow PKCE (console.anthropic.com)
   OU renseigner une clé API manuelle
3. La webapp appelle `POST /api/auth/apikey` → écrit `.webapp-auth.json`
   → redémarre `eca-server` via Docker socket
4. `eca-bootstrap.sh` lit `.webapp-auth.json` → injecte `ANTHROPIC_API_KEY`

#### Codes d'erreur distingués (depuis v#C)

| Code HTTP | Signification | Cause probable |
|---|---|---|
| `401` | Token ECA invalide | `ECA_REMOTE_PASSWORD` incorrect ou manquant dans `.env` |
| `503` | Serveur ECA inaccessible | Container `eca-server` arrêté ou réseau Docker |
| `403` | Accès refusé | Token valide mais périmètre insuffisant |
