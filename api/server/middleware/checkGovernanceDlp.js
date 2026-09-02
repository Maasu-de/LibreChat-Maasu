const { logger } = require('@librechat/data-schemas');
const {
  getModel,
  checkTextSubmission,
  createDlpFailure,
  createDlpIntervention,
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

    if (result.decision === 'ALLOW' || result.decision === 'WARN' || result.decision === 'MASK') {
      req.governanceDlpEligible = true;
      return next();
    }

    return await denyRequest(req, res, createDlpIntervention(result).body);
  } catch (error) {
    logger.error('[GovernanceDlp] preflight failed', {
      code: error?.code ?? 'dlp_check_failed',
    });
    return await denyRequest(req, res, createDlpFailure().body);
  }
}

module.exports = checkGovernanceDlp;
