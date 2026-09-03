const { logger } = require('@librechat/data-schemas');
const {
  getModel,
  createDlpBlock,
  createDlpFailure,
  checkTextSubmission,
  isPlainTextSubmission,
  isGovernanceDlpEnabled,
} = require('@librechat/api');
const denyRequest = require('./denyRequest');

/** Thin Express adapter for the server-side Governance DLP preflight. */
async function checkGovernanceDlp(req, res, next) {
  if (!isGovernanceDlpEnabled() || !isPlainTextSubmission(req.body)) {
    return next();
  }

  try {
    const result = await checkTextSubmission({
      text: req.body.text,
      model: getModel(req.body),
      userId: req.user.id,
    });

    if (result.decision === 'BLOCK') {
      return await denyRequest(req, res, createDlpBlock(result).body);
    }

    req.governanceDlpEligible = true;
    return next();
  } catch (error) {
    logger.error('[GovernanceDlp] preflight failed', {
      code: error?.code ?? 'dlp_check_failed',
    });
    return await denyRequest(req, res, createDlpFailure().body);
  }
}

module.exports = checkGovernanceDlp;
