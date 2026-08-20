/**
 * One-shot migration: copy User embeds into domain collections
 * (accounts, cards, addresses, limitpolicies, limitrequests,
 * accountapplications, staffapplications, loginsecurities).
 *
 * Safe to re-run (upsert / idempotent).
 *
 *   npm run migrate:domain
 *   node scripts/migrate-domain.js
 */
require('dotenv').config();

const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error('Set MONGODB_URI (or MONGO_URI) before migrating.');
  }

  await mongoose.connect(uri);
  // Ensure models are registered
  require('../src/models/User');
  const { migrateAllUsers } = require('../src/services/user-domain');
  const result = await migrateAllUsers();
  console.log(`[domain-migrate] synced ${result.migrated}/${result.total} users`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
