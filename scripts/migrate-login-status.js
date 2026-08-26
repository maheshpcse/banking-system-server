/**
 * Backfill User.loginStatus from historical accountStatus.
 *
 * Rules (same as hydrateUser):
 * - If loginStatus already set → skip
 * - If accountStatus in blocked|deactivated|deleted → loginStatus = that value
 * - Else → loginStatus = 'active'
 *
 * Does NOT write loginStatus to Account (portal-only field).
 *
 *   node scripts/migrate-login-status.js
 */
require('dotenv').config();

const mongoose = require('mongoose');

const LOGIN_RESTRICTED = new Set(['blocked', 'deactivated', 'deleted']);

function deriveLoginStatus(accountStatus) {
  const banking = String(accountStatus || '').trim();
  if (LOGIN_RESTRICTED.has(banking)) return banking;
  return 'active';
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error('Set MONGODB_URI (or MONGO_URI) before migrating.');
  }

  await mongoose.connect(uri);
  const User = require('../src/models/User');

  const users = await User.find({}).select('_id loginStatus accountStatus email username');
  let updated = 0;
  let skipped = 0;

  for (const user of users) {
    const raw = user.loginStatus;
    if (raw != null && String(raw).trim() !== '') {
      skipped += 1;
      continue;
    }
    const next = deriveLoginStatus(user.accountStatus);
    await User.updateOne({ _id: user._id }, { $set: { loginStatus: next } });
    updated += 1;
  }

  console.log(
    `[login-status-migrate] updated ${updated}, skipped ${skipped}, total ${users.length}`
  );
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
