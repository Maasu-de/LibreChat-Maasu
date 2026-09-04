const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { createDlpFailure, checkTextSubmission, isGovernanceDlpEnabled } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

router.use(requireJwtAuth);

router.post('/dlp/check', async (req, res) => {
  if (!isGovernanceDlpEnabled()) {
    return res.status(200).json({ enabled: false });
  }

  const { text, model } = req.body;
  if (typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ message: 'Text must be a non-empty string.' });
  }
  if (typeof model !== 'string' || model.trim() === '') {
    return res.status(400).json({ message: 'Model must be a non-empty string.' });
  }

  try {
    const result = await checkTextSubmission({
      text,
      model,
      userId: req.user.id,
    });

    return res.status(200).json({
      enabled: true,
      decision: result.decision,
      policyVersion: result.policyVersion,
      findings: result.findings,
      maskedPreview: result.maskedPreview,
    });
  } catch (error) {
    logger.error('[GovernanceDlp] UI preflight failed', {
      code: error?.code ?? 'dlp_check_failed',
    });
    const failure = createDlpFailure();
    return res.status(failure.status).json(failure.body);
  }
});

module.exports = router;
