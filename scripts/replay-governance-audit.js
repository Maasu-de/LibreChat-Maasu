require('dotenv').config();
const mongoose = require('mongoose');
const { replayGovernanceGroupAudit } = require('@librechat/api');

async function replay() {
  const ids = process.argv.slice(2);
  if (!ids.length || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
    throw new Error('Usage: node scripts/replay-governance-audit.js <mutation UUID> [...]');
  }
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  try {
    console.log(`Queued ${await replayGovernanceGroupAudit(ids)} event(s) for replay`);
  } finally {
    await mongoose.disconnect();
  }
}
replay().catch(() => {
  console.error('Audit replay failed; check configuration and mutation IDs');
  process.exitCode = 1;
});
