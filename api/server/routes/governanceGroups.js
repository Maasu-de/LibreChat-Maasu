const express = require('express');
const { requireGovernanceAdminToken, createListGovernanceGroups } = require('@librechat/api');
const { listGroups } = require('~/models');

const router = express.Router();

router.get('/', requireGovernanceAdminToken, createListGovernanceGroups({ listGroups }));

module.exports = router;
module.exports.requireGovernanceAdminToken = requireGovernanceAdminToken;
