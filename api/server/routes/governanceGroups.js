const express = require('express');
const { createRequireGovernanceAdminToken, createListGovernanceGroups } = require('@librechat/api');
const { listGroups } = require('~/models');
const { getOpenIdConfig, exchangeAccessTokenIfNeeded } = require('~/strategies');

const requireGovernanceAdminToken = createRequireGovernanceAdminToken({
  exchangeAccessToken: (accessToken, subject) =>
    exchangeAccessTokenIfNeeded(getOpenIdConfig(), accessToken, subject),
});

const router = express.Router();

router.get('/', requireGovernanceAdminToken, createListGovernanceGroups({ listGroups }));

module.exports = router;
module.exports.requireGovernanceAdminToken = requireGovernanceAdminToken;
