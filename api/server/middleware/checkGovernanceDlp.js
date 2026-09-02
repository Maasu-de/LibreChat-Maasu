const { logger } = require('@librechat/data-schemas');
const {
  checkTextSubmission,
  createDlpFailure,
  createDlpIntervention,
  isGovernanceDlpEnabled,
} = require('@librechat/api');
const denyRequest = require('./denyRequest');

function hasSelectedTools(ephemeralAgent) {
  return (
    (Array.isArray(ephemeralAgent?.mcp) && ephemeralAgent.mcp.length > 0) ||
    ephemeralAgent?.web_search === true ||
    ephemeralAgent?.file_search === true ||
    ephemeralAgent?.execute_code === true
  );
}

function isPlainTextSubmission(body) {
  return (
    typeof body?.text === 'string' &&
    body.text.trim().length > 0 &&
    body.editedContent == null &&
    body.isContinued !== true &&
    body.isRegenerate !== true &&
    body.addedConvo == null &&
    body.agent_id == null &&
    body.assistant_id == null &&
    (body.files == null || (Array.isArray(body.files) && body.files.length === 0)) &&
    (body.tools == null || (Array.isArray(body.tools) && body.tools.length === 0)) &&
    !hasSelectedTools(body.ephemeralAgent)
  );
}

function getModel(body) {
  return (
    body.endpointOption?.model_parameters?.model ||
    body.endpointOption?.modelOptions?.model ||
    body.model ||
    'unknown'
  );
}

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

    if (result.decision === 'ALLOW') {
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
