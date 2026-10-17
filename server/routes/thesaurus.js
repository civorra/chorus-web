/**
 * server/routes/thesaurus.js — Résolution du thésaurus
 *
 *   POST /api/sandboxes/:sbId/thesaurus/resolve
 */
'use strict';

const { Router } = require('express');
const chorus = require('../../chorus');

const router = Router({ mergeParams: true });

router.post('/sandboxes/:sbId/thesaurus/resolve', (req, res) => {
  const { shard, term, sourceImport, action,
          typeElement, slot, value, scope,
          projectId, entityId, projectName } = req.body || {};
  if (!shard || !term || !sourceImport || !action) {
    return res.status(400).json({ ok: false, error: 'shard, term, sourceImport, action requis' });
  }
  try {
    const result = chorus.resolveThesaurusPending(
      req.params.sbId, shard, term, sourceImport, action,
      { typeElement, slot, value, scope, projectId, entityId, projectName }
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
