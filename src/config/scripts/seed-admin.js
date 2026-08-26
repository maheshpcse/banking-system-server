/**
 * Seed / promote a NovaBank staff user in MongoDB.
 *
 * First admin seeded this way becomes Super Admin (isSuperAdmin=true).
 * Additional managers/admins should self-register via /auth/staff-signup
 * and wait for Super Admin approval.
 *
 *   npm run seed:admin
 *   ADMIN_ROLE=admin node src/config/scripts/seed-admin.js
 *   ADMIN_ROLE=manager ADMIN_USERNAME=manager ADMIN_EMAIL=manager@novabank.local node scripts/seed-admin.js
 */
require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../../models/User');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error('Set MONGODB_URI (or MONGO_URI) before seeding.');
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
      fullName: role === 'admin' ? 'NovaBank Super Admin' : 'NovaBank Manager',
      username,
      email,
      password,
      role,
      isSuperAdmin: role === 'admin',
      staffStatus: 'active',
      accountNumber: null,
      loginStatus: 'active',
      accountStatus: 'active',
      balance: 0,
      avatar: { style: 'slate', initials: 'NB', image: null }
    });
    console.log(`Created ${role} user: ${username} / ${email}${role === 'admin' ? ' (Super Admin)' : ''}`);
  } else {
    user.role = role;
    user.password = password;
    user.loginStatus = user.loginStatus || 'active';
    user.accountStatus = user.accountStatus || 'active';
    user.staffStatus = 'active';
    if (role === 'admin') {
      user.isSuperAdmin = true;
    }
    await user.save();
    console.log(`Updated existing user to ${role}: ${username} / ${email}`);
  }

  console.log('Sign in on the same Login page with:');
  console.log(`  username: ${username}`);
  console.log(`  password: ${password}`);
  console.log(
    role === 'manager'
      ? 'Managers are redirected to /manager after login.'
      : 'Super Admin is redirected to /admin after login.'
  );

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
