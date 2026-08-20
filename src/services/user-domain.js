const User = require('../models/User');
const Account = require('../models/Account');
const Card = require('../models/Card');
const Address = require('../models/Address');
const LimitPolicy = require('../models/LimitPolicy');
const LimitRequest = require('../models/LimitRequest');
const AccountApplication = require('../models/AccountApplication');
const StaffApplication = require('../models/StaffApplication');
const LoginSecurity = require('../models/LoginSecurity');
const AuditLog = require('../models/AuditLog');

const DEFAULT_LIMITS = Object.freeze({
  depositDaily: 5000,
  withdrawDaily: 2000,
  transferDaily: 3000,
  transferCountDaily: 10
});

function blankControls() {
  return {
    frozen: false,
    onlinePayments: true,
    contactless: true,
    international: false,
    atmWithdrawals: true
  };
}

function cardPayloadFromEmbed(card) {
  if (!card) return null;
  const raw = card.toObject ? card.toObject() : { ...card };
  return {
    holderName: raw.holderName || '',
    number: raw.number || '',
    expiryMonth: raw.expiryMonth || '',
    expiryYear: raw.expiryYear || '',
    cvv: raw.cvv || '',
    numberHash: raw.numberHash || null,
    comboHash: raw.comboHash || null,
    brand: raw.brand || 'visa',
    accountType: raw.accountType || 'personal',
    accountExpiryMonth: raw.accountExpiryMonth || '',
    accountExpiryYear: raw.accountExpiryYear || '',
    status: raw.status || 'pending',
    controls: { ...blankControls(), ...(raw.controls || {}) }
  };
}

function addressPayloadFromEmbed(address) {
  if (!address) return null;
  const raw = address.toObject ? address.toObject() : { ...address };
  return {
    line1: raw.line1 || '',
    line2: raw.line2 || '',
    city: raw.city || '',
    state: raw.state || '',
    postalCode: raw.postalCode || '',
    country: raw.country || ''
  };
}

/**
 * Prefer domain collections when present; otherwise keep User embeds.
 * Mutates the User document in place so existing handlers / toSafeJSON work.
 */
async function hydrateUser(user) {
  if (!user) return null;
  const userId = user._id;

  const [account, card, address, limits, login, pendingLimit, application] = await Promise.all([
    Account.findOne({ user: userId }),
    Card.findOne({ user: userId }),
    Address.findOne({ user: userId }),
    LimitPolicy.findOne({ user: userId }),
    LoginSecurity.findOne({ user: userId }),
    LimitRequest.findOne({ user: userId, status: 'pending' }).sort({ requestedAt: -1 }),
    AccountApplication.findOne({ user: userId }).sort({ createdAt: -1 })
  ]);

  user.accountDoc = account || null;
  user.cardDoc = card || null;
  user.addressDoc = address || null;
  user.limitDoc = limits || null;
  user.loginDoc = login || null;
  user.pendingLimitDoc = pendingLimit || null;
  user.applicationDoc = application || null;

  // Money fields: User embeds remain the write source during dual-write.
  // Fill from Account only when the User doc is missing them (legacy gap).
  if (account) {
    if (user.accountNumber == null && account.accountNumber != null) {
      user.accountNumber = account.accountNumber;
    }
    if (!user.accountStatus && account.accountStatus) {
      user.accountStatus = account.accountStatus;
    }
    if ((user.balance == null || Number.isNaN(user.balance)) && typeof account.balance === 'number') {
      user.balance = account.balance;
    }
  }

  if (address && !(user.address && (user.address.line1 || user.address.city))) {
    user.address = {
      line1: address.line1 || '',
      line2: address.line2 || '',
      city: address.city || '',
      state: address.state || '',
      postalCode: address.postalCode || '',
      country: address.country || ''
    };
  }

  if (card && !(user.card && (user.card.number || user.card.comboHash))) {
    user.card = {
      holderName: card.holderName || '',
      number: card.number || '',
      expiryMonth: card.expiryMonth || '',
      expiryYear: card.expiryYear || '',
      cvv: card.cvv || '',
      numberHash: card.numberHash || null,
      comboHash: card.comboHash || null,
      brand: card.brand || 'visa',
      accountType: card.accountType || 'personal',
      accountExpiryMonth: card.accountExpiryMonth || '',
      accountExpiryYear: card.accountExpiryYear || '',
      status: card.status || 'pending',
      controls: { ...blankControls(), ...(card.controls || {}) }
    };
  }

  if (limits && !user.limits) {
    user.limits = {
      depositDaily: limits.depositDaily,
      withdrawDaily: limits.withdrawDaily,
      transferDaily: limits.transferDaily,
      transferCountDaily: limits.transferCountDaily
    };
  }

  // Login lockout: prefer LoginSecurity when present
  if (login) {
    user.loginAttempts = {
      count: login.count || 0,
      lockedUntil: login.lockedUntil || null,
      lastFailedAt: login.lastFailedAt || null
    };
  }

  if (pendingLimit) {
    user.pendingLimitRequest = {
      status: 'pending',
      requestedAt: pendingLimit.requestedAt,
      decidedAt: pendingLimit.decidedAt || null,
      reviewNote: pendingLimit.reviewNote || null,
      proposed: pendingLimit.proposed || null
    };
  }

  return user;
}

async function hydrateUsers(users) {
  await Promise.all(users.map((u) => hydrateUser(u)));
  return users;
}

/**
 * Copy User embeds into domain collections (idempotent upsert).
 * Used by boot migration and User post-save dual-write.
 */
async function syncUserToDomain(user) {
  if (!user?._id) return;
  const userId = user._id;

  await Account.findOneAndUpdate(
    { user: userId },
    {
      $set: {
        accountNumber: user.accountNumber ?? null,
        accountStatus: user.accountStatus || 'address_required',
        balance: typeof user.balance === 'number' ? user.balance : 0,
        currency: user.settings?.currency || null
      },
      $setOnInsert: { user: userId }
    },
    { upsert: true, new: true }
  );

  const addr = addressPayloadFromEmbed(user.address);
  if (addr && (addr.line1 || addr.city || addr.country || addr.postalCode)) {
    await Address.findOneAndUpdate(
      { user: userId },
      { $set: addr, $setOnInsert: { user: userId } },
      { upsert: true, new: true }
    );
  }

  const cardPayload = cardPayloadFromEmbed(user.card);
  if (cardPayload && (cardPayload.number || cardPayload.comboHash || cardPayload.numberHash)) {
    // Bypass Card pre-save seal when values are already sealed on User
    await Card.findOneAndUpdate(
      { user: userId },
      { $set: cardPayload, $setOnInsert: { user: userId } },
      { upsert: true, new: true, runValidators: true }
    );
  }

  const lim = user.limits || {};
  await LimitPolicy.findOneAndUpdate(
    { user: userId },
    {
      $set: {
        depositDaily: lim.depositDaily ?? DEFAULT_LIMITS.depositDaily,
        withdrawDaily: lim.withdrawDaily ?? DEFAULT_LIMITS.withdrawDaily,
        transferDaily: lim.transferDaily ?? DEFAULT_LIMITS.transferDaily,
        transferCountDaily: lim.transferCountDaily ?? DEFAULT_LIMITS.transferCountDaily
      },
      $setOnInsert: { user: userId }
    },
    { upsert: true, new: true }
  );

  const la = user.loginAttempts || {};
  await LoginSecurity.findOneAndUpdate(
    { user: userId },
    {
      $set: {
        count: la.count || 0,
        lockedUntil: la.lockedUntil || null,
        lastFailedAt: la.lastFailedAt || null
      },
      $setOnInsert: { user: userId }
    },
    { upsert: true, new: true }
  );

  const pending = user.pendingLimitRequest;
  if (pending && pending.status === 'pending' && pending.proposed) {
    const existing = await LimitRequest.findOne({ user: userId, status: 'pending' });
    if (existing) {
      existing.proposed = pending.proposed;
      existing.requestedAt = pending.requestedAt || existing.requestedAt;
      await existing.save();
    } else {
      await LimitRequest.create({
        user: userId,
        status: 'pending',
        requestedAt: pending.requestedAt || new Date(),
        proposed: pending.proposed
      });
    }
  } else if (pending && (pending.status === 'approved' || pending.status === 'rejected')) {
    const open = await LimitRequest.findOne({ user: userId, status: 'pending' });
    if (open) {
      open.status = pending.status;
      open.decidedAt = pending.decidedAt || new Date();
      open.reviewNote = pending.reviewNote || '';
      await open.save();
    }
  }

  if (user.accountStatus === 'under_review') {
    const openApp = await AccountApplication.findOne({
      user: userId,
      status: 'under_review'
    });
    if (!openApp) {
      await AccountApplication.create({
        user: userId,
        status: 'under_review',
        submittedAt: new Date(),
        addressSnapshot: addressPayloadFromEmbed(user.address) || undefined,
        cardSnapshot: user.card
          ? {
              holderName: user.card.holderName,
              brand: user.card.brand,
              accountType: user.card.accountType,
              expiryMonth: user.card.expiryMonth,
              expiryYear: user.card.expiryYear
            }
          : undefined
      });
    }
  } else if (['active', 'approved', 'rejected'].includes(user.accountStatus)) {
    const openApp = await AccountApplication.findOne({
      user: userId,
      status: 'under_review'
    });
    if (openApp) {
      openApp.status = user.accountStatus === 'rejected' ? 'rejected' : 'approved';
      openApp.decidedAt = new Date();
      await openApp.save();
    }
  }

  if (['manager', 'admin'].includes(user.role) && !user.isSuperAdmin) {
    const staffStatus = user.staffStatus || 'active';
    await StaffApplication.findOneAndUpdate(
      { user: userId },
      {
        $set: {
          role: user.role,
          status: staffStatus,
          fullName: user.fullName,
          username: user.username,
          email: user.email,
          decidedAt:
            staffStatus === 'active' || staffStatus === 'rejected' ? new Date() : undefined
        },
        $setOnInsert: {
          user: userId,
          submittedAt: user.createdAt || new Date()
        }
      },
      { upsert: true, new: true }
    );
  }
}

async function migrateAllUsers() {
  const users = await User.find({});
  let migrated = 0;
  for (const user of users) {
    await syncUserToDomain(user);
    migrated += 1;
  }
  return { total: users.length, migrated };
}

async function writeAudit({ actorId, targetUserId, action, meta, ip, userAgent }) {
  try {
    await AuditLog.create({
      actor: actorId || undefined,
      targetUser: targetUserId || undefined,
      action,
      meta: meta || undefined,
      ip: ip || undefined,
      userAgent: userAgent || undefined
    });
  } catch (err) {
    console.warn('[audit]', err.message);
  }
}

async function findUserByAccountNumber(accountNumber) {
  const clean = String(accountNumber || '').trim().toUpperCase();
  if (!clean) return null;

  const account = await Account.findOne({ accountNumber: clean });
  if (account) {
    const user = await User.findById(account.user);
    if (user) {
      await hydrateUser(user);
      return user;
    }
  }

  // Legacy fallback while embeds still carry accountNumber
  const legacy = await User.findOne({ accountNumber: clean });
  if (legacy) {
    await hydrateUser(legacy);
  }
  return legacy;
}

async function searchAccountsByPrefix(q, excludeUserId, limit = 8) {
  const prefix = String(q || '').trim().toUpperCase();
  if (prefix.length < 2) return [];

  const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const accounts = await Account.find({
    user: { $ne: excludeUserId },
    accountNumber: { $ne: null, $regex: `^${escapeRegex(prefix)}` },
    accountStatus: { $in: ['active', 'approved'] }
  })
    .limit(limit)
    .lean();

  if (!accounts.length) {
    // Legacy fallback
    const users = await User.find({
      _id: { $ne: excludeUserId },
      role: 'customer',
      accountNumber: { $ne: null, $regex: `^${escapeRegex(prefix)}` },
      accountStatus: { $in: ['active', 'approved'] }
    })
      .select('fullName accountNumber')
      .limit(limit)
      .lean();
    return users.map((u) => ({ accountNumber: u.accountNumber, fullName: u.fullName }));
  }

  const userIds = accounts.map((a) => a.user);
  const users = await User.find({ _id: { $in: userIds }, role: 'customer' })
    .select('fullName')
    .lean();
  const nameById = new Map(users.map((u) => [String(u._id), u.fullName]));

  return accounts
    .filter((a) => nameById.has(String(a.user)))
    .map((a) => ({
      accountNumber: a.accountNumber,
      fullName: nameById.get(String(a.user))
    }));
}

async function accountNumberExists(accountNumber, excludeUserId) {
  const clean = String(accountNumber || '').trim().toUpperCase();
  const accountQ = { accountNumber: clean };
  if (excludeUserId) accountQ.user = { $ne: excludeUserId };
  if (await Account.findOne(accountQ).select('_id')) return true;

  const userQ = { accountNumber: clean };
  if (excludeUserId) userQ._id = { $ne: excludeUserId };
  return !!(await User.findOne(userQ).select('_id'));
}

async function deleteUserDomain(userId) {
  await Promise.all([
    Account.deleteMany({ user: userId }),
    Card.deleteMany({ user: userId }),
    Address.deleteMany({ user: userId }),
    LimitPolicy.deleteMany({ user: userId }),
    LimitRequest.deleteMany({ user: userId }),
    AccountApplication.deleteMany({ user: userId }),
    StaffApplication.deleteMany({ user: userId }),
    LoginSecurity.deleteMany({ user: userId })
  ]);
}

module.exports = {
  DEFAULT_LIMITS,
  hydrateUser,
  hydrateUsers,
  syncUserToDomain,
  migrateAllUsers,
  writeAudit,
  findUserByAccountNumber,
  searchAccountsByPrefix,
  accountNumberExists,
  deleteUserDomain,
  Account,
  Card,
  Address,
  LimitPolicy,
  LimitRequest,
  AccountApplication,
  StaffApplication,
  LoginSecurity,
  AuditLog
};
