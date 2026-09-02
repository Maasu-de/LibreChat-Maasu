const express = require('express');
const { testGovernanceConnection } = require('@librechat/api');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');

const router = express.Router();

router.get('/health', requireJwtAuth, testGovernanceConnection);

module.exports = router;
