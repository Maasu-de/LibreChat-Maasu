const express = require('express');
const { Types } = require('mongoose');
const {
  generateCheckAccess,
  createGetGovernanceUsage,
  testGovernanceConnection,
} = require('@librechat/api');
const { Permissions, PermissionTypes } = require('librechat-data-provider');
const { requireJwtAuth } = require('~/server/middleware');
const { getRoleByName, findUsers } = require('~/models');
const { Group } = require('~/db/models');

const router = express.Router();

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
