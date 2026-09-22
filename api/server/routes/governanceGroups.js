const crypto = require('crypto');
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const db = require('~/models');

const router = express.Router();
const PAGE_SIZE = 200;

const digest = (value) => crypto.createHash('sha256').update(value).digest();

/**
 * Service-to-service check. Only the Governance Admin server holds this
 * credential; there is no user session on this path.
 */
function requireGroupLookupCredential(req, res, next) {
  const expected = process.env.LIBRECHAT_GROUP_LOOKUP_CREDENTIAL ?? '';
  if (!expected) {
    return res.status(503).json({ message: 'Group lookup is not configured.' });
  }

  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!provided || !crypto.timingSafeEqual(digest(provided), digest(expected))) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  return next();
}

router.get('/', requireGroupLookupCredential, async (_req, res) => {
  try {
    const groups = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await db.listGroups({ limit: PAGE_SIZE, offset });
      groups.push(...page);
      if (page.length < PAGE_SIZE) {
        break;
      }
    }

    return res.status(200).json({
      groups: groups.map((group) => ({
        id: group._id.toString(),
        name: group.name,
        source: group.source,
      })),
    });
  } catch (error) {
    logger.error('[GovernanceGroups] Group lookup failed', { message: error?.message });
    return res.status(500).json({ message: 'Unable to list groups.' });
  }
});

module.exports = router;
