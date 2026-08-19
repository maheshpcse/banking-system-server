const { isExpiryCurrentOrFuture, normalizeCardNumber, roundMoney } = require('./helpers');
const { decryptSecret, hashCardCombo } = require('./card-crypto');

/**
 * @param {object} user
 * @param {{ channel?: 'online' | 'atm' | 'contactless' | 'international' }} [opts]
 * Channel maps to card.controls:
 * - online → onlinePayments (app deposit / transfer)
 * - atm → atmWithdrawals (withdraw)
 * - contactless → contactless
 * - international → international
 * frozen always blocks every channel.
 */
function moneyGate(user, { channel = 'online' } = {}) {
  if (!user?.accountNumber) {
    return 'Account number is required before this action. Complete account opening first.';
  }
  if (user.accountStatus && !['active', 'approved'].includes(user.accountStatus)) {
    return 'Account is not active for money movement.';
  }
  if (!isExpiryCurrentOrFuture(user.card?.accountExpiryMonth, user.card?.accountExpiryYear)) {
    return 'Account number validity has expired. Update Card info and wait for review.';
  }
  const plainNumber = decryptSecret(user.card?.number);
  const plainCvv = decryptSecret(user.card?.cvv);
  if (!plainNumber || !plainCvv) {
    return 'Card details are required before money movement.';
  }
  if (!isExpiryCurrentOrFuture(user.card.expiryMonth, user.card.expiryYear)) {
    return 'Card expiry is in the past. Update your card details.';
  }
  const status = user.card.status || 'pending';
  const controls = user.card.controls || {};
  if (status === 'blocked' || status === 'frozen' || controls.frozen) {
    return 'Your ATM card is frozen or blocked. Unfreeze it from Account → Card controls.';
  }
  if (user.accountNumber && status !== 'active') {
    return 'Your ATM card must be active before money movement. Complete opening or unfreeze the card.';
  }

  const normalized = String(channel || 'online').toLowerCase();
  if (normalized === 'atm') {
    if (controls.atmWithdrawals === false) {
      return 'ATM withdrawals are disabled on your card controls.';
    }
  } else if (normalized === 'contactless') {
    if (controls.contactless === false) {
      return 'Contactless payments are disabled on your card controls.';
    }
  } else if (normalized === 'international') {
    if (!controls.international) {
      return 'International transactions are disabled on your card controls.';
    }
  } else {
    // online (default) — deposits & transfers through the NovaBank app
    if (controls.onlinePayments === false) {
      return 'Online payments are disabled on your card controls. Enable them under Account → Card controls.';
    }
  }
  return null;
}

/** Rolling 24-hour window (not calendar midnight). */
async function sumRolling24h(Transaction, userId, types) {
  const start = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await Transaction.aggregate([
    {
      $match: {
        user: userId,
        type: { $in: types },
        createdAt: { $gte: start }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    }
  ]);
  return {
    total: roundMoney(rows[0]?.total || 0),
    count: rows[0]?.count || 0
  };
}

/** @deprecated alias — prefer sumRolling24h */
const sumToday = sumRolling24h;

async function assertDailyLimit(Transaction, user, type, amount) {
  const limits = user.limits || {};
  if (type === 'deposit') {
    const used = await sumRolling24h(Transaction, user._id, ['deposit']);
    const cap = limits.depositDaily ?? 5000;
    if (used.total + amount > cap) {
      return `24-hour deposit limit is $${cap.toFixed(2)}. Used $${used.total.toFixed(2)} in the last 24 hours.`;
    }
  }
  if (type === 'withdraw') {
    const used = await sumRolling24h(Transaction, user._id, ['withdraw']);
    const cap = limits.withdrawDaily ?? 2000;
    if (used.total + amount > cap) {
      return `24-hour withdraw limit is $${cap.toFixed(2)}. Used $${used.total.toFixed(2)} in the last 24 hours.`;
    }
  }
  if (type === 'transfer') {
    const used = await sumRolling24h(Transaction, user._id, ['transfer_out']);
    const amountCap = limits.transferDaily ?? 3000;
    const countCap = limits.transferCountDaily ?? 10;
    if (used.count >= countCap) {
      return `24-hour transfer count limit is ${countCap}. You already sent ${used.count} in the last 24 hours.`;
    }
    if (used.total + amount > amountCap) {
      return `24-hour transfer amount limit is $${amountCap.toFixed(2)}. Used $${used.total.toFixed(2)} in the last 24 hours.`;
    }
  }
  return null;
}

async function assertUniqueCardCombo(User, number, cvv, excludeUserId) {
  const cleanNumber = normalizeCardNumber(number);
  const cleanCvv = String(cvv || '').replace(/\D/g, '');
  if (!cleanNumber || !cleanCvv) {
    return 'Card number and CVV are required';
  }
  const comboHash = hashCardCombo(cleanNumber, cleanCvv);
  const query = {
    $or: [
      { 'card.comboHash': comboHash },
      // Legacy plaintext rows (pre-encryption migration)
      { 'card.number': cleanNumber, 'card.cvv': cleanCvv }
    ]
  };
  if (excludeUserId) {
    query._id = { $ne: excludeUserId };
  }
  const clash = await User.findOne(query).select('_id');
  if (clash) {
    return 'This Card Number + CVV combination is already registered to another customer';
  }
  return null;
}

function resolveMoneyChannel(bodyChannel, fallback) {
  const allowed = new Set(['online', 'atm', 'contactless', 'international']);
  const raw = String(bodyChannel || fallback || 'online').toLowerCase();
  return allowed.has(raw) ? raw : fallback || 'online';
}

module.exports = {
  moneyGate,
  sumToday,
  sumRolling24h,
  assertDailyLimit,
  assertUniqueCardCombo,
  normalizeCardNumber,
  isExpiryCurrentOrFuture,
  resolveMoneyChannel
};
