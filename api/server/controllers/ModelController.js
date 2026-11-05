const { isGovernancePilotEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { loadDefaultModels, loadConfigModels } = require('~/server/services/Config');

const getModelsConfig = (req) => loadModels(req);

async function loadModels(req) {
  const defaultModelsConfig = isGovernancePilotEnabled() ? {} : await loadDefaultModels(req);
  const customModelsConfig = await loadConfigModels(req);
  return { ...defaultModelsConfig, ...customModelsConfig };
}

async function modelController(req, res) {
  try {
    if (isGovernancePilotEnabled() && req.query.include === 'governance') {
      const metadata = {};
      await loadConfigModels(req, metadata);
      return res.send(metadata);
    }
    const modelConfig = await loadModels(req);
    res.send(modelConfig);
  } catch (error) {
    logger.error('Error fetching models:', error);
    res.status(500).send({ error: error.message });
  }
}

module.exports = { modelController, loadModels, getModelsConfig };
