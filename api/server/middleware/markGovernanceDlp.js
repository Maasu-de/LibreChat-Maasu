const { logger } = require('@librechat/data-schemas');
const {
  isPlainTextSubmission,
  isGovernanceDlpEnabled,
  isGovernancePilotEnabled,
} = require('@librechat/api');
const { getUserGroupIds } = require('~/server/services/governanceGroups');
const denyRequest = require('./denyRequest');

const GROUP_LOOKUP_FAILURE_MESSAGE =
  'The message could not be checked against the data loss prevention policy. Please try again later.';

/**
 * Marks plain-text sends for the governed DLP flow. The completion call itself asks the
 * Governance Backend for the user's approval, so no separate check runs here. A governed send
 * also carries the user's group IDs, resolved here on the server so the browser cannot choose
 * which group-scoped policy overrides apply; without them the send is refused.
 */
async function markGovernanceDlp(req, res, next) {
  req.governanceDlpEligible = isGovernanceDlpEnabled() && isPlainTextSubmission(req.body);
  if (!req.governanceDlpEligible && !isGovernancePilotEnabled()) {
    return next();
  }

  try {
    req.governanceGroupIds = await getUserGroupIds(req.user.id);
  } catch (error) {
    logger.error('[GovernanceDlp] group lookup failed', { message: error?.message });
    return await denyRequest(req, res, GROUP_LOOKUP_FAILURE_MESSAGE);
  }
  return next();
}

module.exports = markGovernanceDlp;
