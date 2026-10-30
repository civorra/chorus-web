/**
 * server/routes/thesaurus.js — Résolution du thésaurus
 *
 *   POST /api/sandboxes/:sbId/thesaurus/resolve
 *   POST /api/sandboxes/:sbId/thesaurus/unconfirm
 */
'use strict';

const { Router } = require('express');
const chorus = require('../../chorus');

const router = Router({ mergeParams: true });

router.post('/sandboxes/:sbId/thesaurus/resolve', (req, res) => {
  const { shard, term, sourceImport, action,
          typeElement, slot, value, scope,
          projectId, entityId, projectName,
          entityPromote } = req.body || {};
  if (!shard || !term || !sourceImport || !action) {
    return res.status(400).json({ ok: false, error: 'shard, term, sourceImport, action requis' });
  }
  try {
    const result = chorus.resolveThesaurusPending(
      req.params.sbId, shard, term, sourceImport, action,
      { typeElement, slot, value, scope, projectId, entityId, projectName, entityPromote }
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/sandboxes/:sbId/thesaurus/unconfirm — annule une confirmation
// manuelle (webapp) et remet la ligne en * Pending (global.org). Refuse
// explicitement toute tentative sur un alias résolu à l'import — voir
// chorus/thesaurus.js § unconfirmThesaurusAlias.
router.post('/sandboxes/:sbId/thesaurus/unconfirm', (req, res) => {
  const { shard, term, sourceImport,
          projectId, entityId, projectName } = req.body || {};
  if (!shard || !term || !sourceImport) {
    return res.status(400).json({ ok: false, error: 'shard, term, sourceImport requis' });
  }
  try {
    const result = chorus.unconfirmThesaurusAlias(
      req.params.sbId, shard, term, sourceImport,
      { projectId, entityId, projectName }
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
