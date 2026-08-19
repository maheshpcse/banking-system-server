const { isExpiryCurrentOrFuture, normalizeCardNumber, roundMoney } = require('./helpers');

function moneyGate(user, { requireAtm = false } = {}) {
  if (!user?.accountNumber) {
    return 'Account number is required before this action. Complete account opening first.';
  }
  if (user.accountStatus && !['active', 'approved'].includes(user.accountStatus)) {
    return 'Account is not active for money movement.';
  }
  if (!isExpiryCurrentOrFuture(user.card?.accountExpiryMonth, user.card?.accountExpiryYear)) {
    return 'Account number validity has expired. Update Card info and wait for review.';
  }
  if (!user.card?.number || !user.card?.cvv) {
    return 'Card details are required before money movement.';
  }
  if (!isExpiryCurrentOrFuture(user.card.expiryMonth, user.card.expiryYear)) {
    return 'Card expiry is in the past. Update your card details.';
  }
  const status = user.card.status || 'pending';
  if (status === 'blocked' || status === 'frozen' || user.card.controls?.frozen) {
    return 'Your ATM card is frozen or blocked. Unfreeze it from Account → Card controls.';
  }
  if (user.accountNumber && status !== 'active') {
    return 'Your ATM card must be active before money movement. Complete opening or unfreeze the card.';
  }
  if (requireAtm && user.card.controls?.atmWithdrawals === false) {
    return 'ATM withdrawals are disabled on your card controls.';
  }
  return null;
}

async function sumToday(Transaction, userId, types) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
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

async function assertDailyLimit(Transaction, user, type, amount) {
  const limits = user.limits || {};
  if (type === 'deposit') {
    const used = await sumToday(Transaction, user._id, ['deposit']);
    const cap = limits.depositDaily ?? 5000;
    if (used.total + amount > cap) {
      return `Daily deposit limit is $${cap.toFixed(2)}. Used $${used.total.toFixed(2)} today.`;
    }
  }
  if (type === 'withdraw') {
    const used = await sumToday(Transaction, user._id, ['withdraw']);
    const cap = limits.withdrawDaily ?? 2000;
    if (used.total + amount > cap) {
      return `Daily withdraw limit is $${cap.toFixed(2)}. Used $${used.total.toFixed(2)} today.`;
    }
  }
  if (type === 'transfer') {
    const used = await sumToday(Transaction, user._id, ['transfer_out']);
    const amountCap = limits.transferDaily ?? 3000;
    const countCap = limits.transferCountDaily ?? 10;
    if (used.count >= countCap) {
      return `Daily transfer count limit is ${countCap}. You already sent ${used.count} today.`;
    }
    if (used.total + amount > amountCap) {
      return `Daily transfer amount limit is $${amountCap.toFixed(2)}. Used $${used.total.toFixed(2)} today.`;
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
  const query = {
    'card.number': cleanNumber,
    'card.cvv': cleanCvv
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

module.exports = {
  moneyGate,
  sumToday,
  assertDailyLimit,
  assertUniqueCardCombo,
  normalizeCardNumber,
  isExpiryCurrentOrFuture
};
