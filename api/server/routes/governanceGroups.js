const express = require('express');
const { requireGovernanceGatewayService, createListGovernanceGroups } = require('@librechat/api');
const { listGroups } = require('~/models');

const router = express.Router();

router.get('/', requireGovernanceGatewayService, createListGovernanceGroups({ listGroups }));

module.exports = router;
module.exports.requireGovernanceGatewayService = requireGovernanceGatewayService;
