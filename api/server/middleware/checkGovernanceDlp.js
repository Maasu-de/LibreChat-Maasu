const { isPlainTextSubmission, isGovernanceDlpEnabled } = require('@librechat/api');

/**
 * Marks plain-text sends for the governed DLP flow. The completion call itself asks the
 * Governance Backend for the user's approval, so no separate check runs here.
 */
function checkGovernanceDlp(req, res, next) {
  req.governanceDlpEligible = isGovernanceDlpEnabled() && isPlainTextSubmission(req.body);
  return next();
}

module.exports = checkGovernanceDlp;
