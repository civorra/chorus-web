/**
 * chorus/fs.js — Config et helpers filesystem bas niveau
 *
 * Fournit CHORUS_HOME, SANDBOXES_DIR et les fonctions utilitaires
 * de lecture/listage/vérification de fichiers utilisées par tous les
 * autres modules du package chorus/.
 */

'use strict';

const fs   = require('fs');
const path = require('path'); // eslint-disable-line no-unused-vars — ré-exporté implicitement via path helpers

const CHORUS_HOME = () => {
  const h = process.env.CHORUS_HOME;
  if (!h) throw new Error('CHORUS_HOME non défini dans .env');
  return h;
};

// Répertoire racine des sandboxes — distinct de CHORUS_HOME pour permettre
// de monter tout le dépôt Chorus (y compris engine/lib pour PERL5LIB) tout
// en pointant précisément vers engine/sandboxes.
const SANDBOXES_DIR = () => process.env.SANDBOXES || '/chorus/engine/sandboxes';

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function listDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch { return []; }
}

function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

module.exports = { CHORUS_HOME, SANDBOXES_DIR, readFileSafe, listDirs, fileExists };
