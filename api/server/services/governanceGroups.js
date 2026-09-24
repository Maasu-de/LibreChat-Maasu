const { getUserGroups } = require('~/models');

/** IDs of the LibreChat groups a user belongs to, as sent to the governance backend. */
async function getUserGroupIds(userId) {
  const groups = await getUserGroups(userId);
  return groups.map((group) => group._id.toString());
}

module.exports = { getUserGroupIds };
