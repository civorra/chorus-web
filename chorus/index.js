/**
 * chorus/index.js — Point d'entrée du package chorus/
 *
 * Re-exporte exactement le même contrat public que l'ancien chorus.js
 * monolithique — server.js et tous les consommateurs peuvent remplacer
 *
 *   const chorus = require('./chorus');
 *
 * par
 *
 *   const chorus = require('./chorus/index');
 *
 * sans aucun autre changement.
 */

'use strict';

const { CHORUS_HOME, SANDBOXES_DIR }     = require('./fs');
const { scanAll, scanSandbox, scanEntity,
        scanProject, scanSandboxCorpus,
        readAgentOrgFile }               = require('./scanner');
const { parseReport, readReport,
        writeCheckReport,
        buildRunReportIndex }            = require('./reports');
const { resolveThesaurusPending }        = require('./thesaurus');

module.exports = {
  CHORUS_HOME,
  SANDBOXES_DIR,
  scanAll,
  scanSandbox,
  scanEntity,
  scanProject,
  parseReport,
  readReport,
  writeCheckReport,
  buildRunReportIndex,
  scanSandboxCorpus,
  readAgentOrgFile,
  resolveThesaurusPending,
};
