/**
 * Seed / promote a NovaBank staff user in MongoDB.
 *
 * Usage (from banking-system-server root, with .env MONGODB_URI set):
 *   node ../banking-system/server-integration/scripts/seed-admin.js
 * or copy this file into the server repo and run:
 *   node scripts/seed-admin.js
 *
 * Default credentials (override with env):
 *   ADMIN_EMAIL=admin@novabank.local
 *   ADMIN_USERNAME=admin
 *   ADMIN_PASSWORD=Admin@12345
 *   ADMIN_ROLE=admin   # or manager
 */
require('dotenv').config();

const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error('Set MONGODB_URI (or MONGO_URI) before seeding.');
  }

  // Prefer the server app User model when this script lives in the server repo.
  let User;
  try {
    User = require('../models/User');
  } catch {
    User = require('../../src/models/User');
  }

  const email = String(process.env.ADMIN_EMAIL || 'admin@novabank.local').toLowerCase().trim();
  const username = String(process.env.ADMIN_USERNAME || 'admin').toLowerCase().trim();
  const password = String(process.env.ADMIN_PASSWORD || 'Admin@12345');
  const role = String(process.env.ADMIN_ROLE || 'admin').toLowerCase().trim();

  if (!['admin', 'manager'].includes(role)) {
    throw new Error('ADMIN_ROLE must be admin or manager');
  }

  await mongoose.connect(uri);

  let user = await User.findOne({ $or: [{ email }, { username }] });
  if (!user) {
    user = await User.create({
      fullName: role === 'admin' ? 'NovaBank Admin' : 'NovaBank Manager',
      username,
      email,
      password,
      role,
      accountNumber: null,
      accountStatus: 'active',
      balance: 0,
      avatar: { style: 'slate', initials: 'NB', image: null }
    });
    console.log(`Created ${role} user: ${username} / ${email}`);
  } else {
    user.role = role;
    user.password = password;
    user.accountStatus = user.accountStatus || 'active';
    await user.save();
    console.log(`Updated existing user to ${role}: ${username} / ${email}`);
  }

  console.log('Sign in on the same Login page with:');
  console.log(`  username: ${username}`);
  console.log(`  password: ${password}`);
  console.log('There is no separate admin login URL — staff are redirected to /admin after login.');

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
