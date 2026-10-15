const express = require('express');
const { Types } = require('mongoose');
const {
  generateCheckAccess,
  createGetGovernanceUsage,
  resolveUsageLabels,
  testGovernanceConnection,
} = require('@librechat/api');
const { Permissions, PermissionTypes } = require('librechat-data-provider');
const { requireJwtAuth } = require('~/server/middleware');
const { getRoleByName, findUsers } = require('~/models');
const { Group } = require('~/db/models');
const governanceGroups = require('./governanceGroups');

const router = express.Router();

// The Governance Admin server authenticates with its own Keycloak token, not a
// LibreChat session, so this route is mounted before requireJwtAuth.
router.use('/groups', governanceGroups);

router.post('/usage-labels', governanceGroups.requireGovernanceAdminToken, async (req, res) => {
  const byUser = req.body?.by_user;
  const usesLegacyTeamKey = req.body?.by_group == null && req.body?.by_team != null;
  const byGroup = req.body?.by_group ?? req.body?.by_team;
  const validRows = (rows) =>
    Array.isArray(rows) &&
    rows.every((row) => typeof row?.key === 'string' && typeof row?.label === 'string');
  if (!validRows(byUser) || !validRows(byGroup)) {
    return res.status(400).json({ message: 'Invalid usage labels request' });
  }

  const result = await resolveUsageLabels(
    { by_user: byUser, by_group: byGroup },
    { findUsers, findGroups },
  );
  return res
    .status(200)
    .json(usesLegacyTeamKey ? { by_user: result.by_user, by_team: result.by_group } : result);
});

router.use(requireJwtAuth);

router.get('/health', testGovernanceConnection);

const checkFinanceRead = generateCheckAccess({
  permissionType: PermissionTypes.FINANCE,
  permissions: [Permissions.READ],
  getRoleByName,
});

/** Usage group IDs may be LibreChat group `_id`s or external (`idOnTheSource`) IDs */
const findGroups = (ids) =>
  Group.find(
    {
      $or: [
        { _id: { $in: ids.filter((id) => Types.ObjectId.isValid(id)) } },
        { idOnTheSource: { $in: ids } },
      ],
    },
    { name: 1, idOnTheSource: 1 },
  ).lean();

router.get('/usage', checkFinanceRead, createGetGovernanceUsage({ findUsers, findGroups }));

module.exports = router;
