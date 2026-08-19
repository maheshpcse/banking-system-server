const express = require('express');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Notification = require('../models/Notification');
const { generateReference, roundMoney } = require('../utils/helpers');
const {
  moneyGate,
  assertDailyLimit,
  assertUniqueCardCombo,
  isExpiryCurrentOrFuture,
  normalizeCardNumber,
  sumRolling24h,
  resolveMoneyChannel
} = require('../utils/banking-rules');
const { sealCardSecrets } = require('../utils/card-crypto');

const router = express.Router();

router.use(auth);

async function notify(userId, kind, title, body, href) {
  try {
    await Notification.create({
      user: userId,
      kind,
      title,
      body,
      href: href || null,
      read: false
    });
  } catch (error) {
    console.warn('Notification create failed:', error.message);
  }
}

function requireActiveAccount(user, channel = 'online') {
  return moneyGate(user, { channel });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.get('/directory', async (req, res) => {
  try {
    const q = String(req.query.q || '')
      .trim()
      .toUpperCase();
    if (q.length < 2) {
      return res.json({ items: [] });
    }

    const users = await User.find({
      _id: { $ne: req.user._id },
      role: 'customer',
      accountNumber: { $ne: null, $regex: `^${escapeRegex(q)}` },
      accountStatus: { $in: ['active', 'approved'] }
    })
      .select('fullName accountNumber')
      .limit(8)
      .lean();

    return res.json({
      items: users.map((user) => {
        const parts = String(user.fullName || '')
          .split(/\s+/)
          .filter(Boolean);
        const displayName =
          parts.length <= 1
            ? parts[0] || 'Customer'
            : `${parts[0]} ${parts
                .slice(1)
                .map((p) => `${p[0]}.`)
                .join(' ')}`;
        return {
          accountNumber: user.accountNumber,
          displayName
        };
      })
    });
  } catch (error) {
    console.error('Directory lookup error:', error);
    return res.status(500).json({ message: 'Unable to look up accounts' });
  }
});

router.get('/summary', async (req, res) => {
  try {
    const recent = await Transaction.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const monthly = await Transaction.aggregate([
      {
        $match: {
          user: req.user._id,
          createdAt: { $gte: monthStart }
        }
      },
      {
        $group: {
          _id: '$type',
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]);

    const monthlyMap = monthly.reduce((acc, item) => {
      acc[item._id] = { total: roundMoney(item.total), count: item.count };
      return acc;
    }, {});

    const [depositToday, withdrawToday, transferToday] = await Promise.all([
      sumRolling24h(Transaction, req.user._id, ['deposit']),
      sumRolling24h(Transaction, req.user._id, ['withdraw']),
      sumRolling24h(Transaction, req.user._id, ['transfer_out'])
    ]);
    const limits = req.user.toSafeJSON().limits;

    return res.json({
      user: req.user.toSafeJSON(),
      recentTransactions: recent,
      monthly: {
        deposits: monthlyMap.deposit || { total: 0, count: 0 },
        withdrawals: monthlyMap.withdraw || { total: 0, count: 0 },
        transfersIn: monthlyMap.transfer_in || { total: 0, count: 0 },
        transfersOut: monthlyMap.transfer_out || { total: 0, count: 0 }
      },
      dailyUsage: {
        window: 'rolling_24h',
        deposit: { used: depositToday.total, limit: limits.depositDaily },
        withdraw: { used: withdrawToday.total, limit: limits.withdrawDaily },
        transfer: {
          used: transferToday.total,
          limit: limits.transferDaily,
          count: transferToday.count,
          countLimit: limits.transferCountDaily
        }
      }
    });
  } catch (error) {
    console.error('Summary error:', error);
    return res.status(500).json({ message: 'Unable to load account summary' });
  }
});

/**
 * Deposit / withdraw / transfer intentionally avoid MongoDB multi-document
 * transactions. Standalone MongoDB (common on Railway / Atlas free / docker
 * single-node) rejects sessions with:
 * "Transaction numbers are only allowed on a replica set member or mongos"
 */
router.post('/deposit', async (req, res) => {
  try {
    const amount = roundMoney(req.body.amount);
    const description = (req.body.description || 'Deposit').trim();

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Enter a valid deposit amount' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Account not found' });
    }
    const channel = resolveMoneyChannel(req.body.channel, 'online');
    const blocked = requireActiveAccount(user, channel);
    if (blocked) {
      return res.status(403).json({ message: blocked });
    }

    const limitHit = await assertDailyLimit(Transaction, user, 'deposit', amount);
    if (limitHit) {
      return res.status(400).json({ message: limitHit });
    }

    const previousBalance = user.balance;
    user.balance = roundMoney(user.balance + amount);
    await user.save();

    try {
      const tx = await Transaction.create({
        user: user._id,
        type: 'deposit',
        amount,
        balanceAfter: user.balance,
        description,
        reference: generateReference('DEP')
      });

      await notify(
        user._id,
        'account',
        'Deposit successful',
        `$${amount.toFixed(2)} was added to your available balance.`,
        '/transactions?type=deposit'
      );

      return res.status(201).json({
        message: 'Deposit successful',
        user: user.toSafeJSON(),
        transaction: tx
      });
    } catch (txError) {
      user.balance = previousBalance;
      await user.save();
      throw txError;
    }
  } catch (error) {
    console.error('Deposit error:', error);
    return res.status(500).json({ message: 'Deposit failed' });
  }
});

router.post('/withdraw', async (req, res) => {
  try {
    const amount = roundMoney(req.body.amount);
    const description = (req.body.description || 'Withdrawal').trim();

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Enter a valid withdrawal amount' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Account not found' });
    }

    const blocked = moneyGate(user, {
      channel: resolveMoneyChannel(req.body.channel, 'atm')
    });
    if (blocked) {
      return res.status(403).json({ message: blocked });
    }
    if (user.balance < amount) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    const limitHit = await assertDailyLimit(Transaction, user, 'withdraw', amount);
    if (limitHit) {
      return res.status(400).json({ message: limitHit });
    }

    const previousBalance = user.balance;
    user.balance = roundMoney(user.balance - amount);
    await user.save();

    try {
      const tx = await Transaction.create({
        user: user._id,
        type: 'withdraw',
        amount,
        balanceAfter: user.balance,
        description,
        reference: generateReference('WDR')
      });

      await notify(
        user._id,
        'account',
        'Withdrawal successful',
        `$${amount.toFixed(2)} was withdrawn from your available balance.`,
        '/transactions?type=withdraw'
      );

      return res.status(201).json({
        message: 'Withdrawal successful',
        user: user.toSafeJSON(),
        transaction: tx
      });
    } catch (txError) {
      user.balance = previousBalance;
      await user.save();
      throw txError;
    }
  } catch (error) {
    console.error('Withdraw error:', error);
    return res.status(500).json({ message: 'Withdrawal failed' });
  }
});

router.post('/transfer', async (req, res) => {
  try {
    const amount = roundMoney(req.body.amount);
    const toAccountNumber = String(req.body.toAccountNumber || '').trim().toUpperCase();
    const description = (req.body.description || 'Transfer').trim();

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Enter a valid transfer amount' });
    }

    if (!toAccountNumber) {
      return res.status(400).json({ message: 'Recipient account number is required' });
    }

    const sender = await User.findById(req.user._id);
    if (!sender) {
      return res.status(404).json({ message: 'Account not found' });
    }

    const blocked = requireActiveAccount(
      sender,
      resolveMoneyChannel(req.body.channel, 'online')
    );
    if (blocked) {
      return res.status(403).json({ message: blocked });
    }

    if (sender.accountNumber === toAccountNumber) {
      return res.status(400).json({ message: 'You cannot transfer to your own account' });
    }

    const recipient = await User.findOne({ accountNumber: toAccountNumber });
    if (!recipient) {
      return res.status(404).json({ message: 'Recipient account not found' });
    }
    if ((recipient.role || 'customer') !== 'customer') {
      return res.status(400).json({ message: 'Recipient must be an active customer account' });
    }
    if (!['active', 'approved'].includes(recipient.accountStatus || '')) {
      return res.status(400).json({ message: 'Recipient account is not active' });
    }
    if (!isExpiryCurrentOrFuture(recipient.card?.accountExpiryMonth, recipient.card?.accountExpiryYear)) {
      return res.status(400).json({ message: 'Recipient account validity has expired' });
    }

    if (sender.balance < amount) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    const limitHit = await assertDailyLimit(Transaction, sender, 'transfer', amount);
    if (limitHit) {
      return res.status(400).json({ message: limitHit });
    }

    const senderPrevious = sender.balance;
    const recipientPrevious = recipient.balance;

    sender.balance = roundMoney(sender.balance - amount);
    recipient.balance = roundMoney(recipient.balance + amount);
    await sender.save();
    await recipient.save();

    const outRef = generateReference('OUT');
    const inRef = generateReference('IN');

    try {
      const outTx = await Transaction.create({
        user: sender._id,
        type: 'transfer_out',
        amount,
        balanceAfter: sender.balance,
        description,
        counterpartyAccount: recipient.accountNumber,
        counterpartyName: recipient.fullName,
        reference: outRef
      });

      await Transaction.create({
        user: recipient._id,
        type: 'transfer_in',
        amount,
        balanceAfter: recipient.balance,
        description,
        counterpartyAccount: sender.accountNumber,
        counterpartyName: sender.fullName,
        reference: inRef
      });

      await notify(
        sender._id,
        'transfer',
        'Transfer sent',
        `$${amount.toFixed(2)} sent to ${recipient.accountNumber}.`,
        '/transactions?type=transfer_out'
      );
      await notify(
        recipient._id,
        'transfer',
        'Transfer received',
        `$${amount.toFixed(2)} received from ${sender.fullName}.`,
        '/transactions?type=transfer_in'
      );

      return res.status(201).json({
        message: 'Transfer successful',
        user: sender.toSafeJSON(),
        transaction: outTx
      });
    } catch (txError) {
      sender.balance = senderPrevious;
      recipient.balance = recipientPrevious;
      await sender.save();
      await recipient.save();
      throw txError;
    }
  } catch (error) {
    console.error('Transfer error:', error);
    return res.status(500).json({ message: 'Transfer failed' });
  }
});

router.post('/application', async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Account not found' });
    }
    const address = req.body.address || {};
    const card = req.body.card || {};
    if (!address.line1 || !address.city || !address.state || !address.postalCode || !address.country) {
      return res.status(400).json({ message: 'Complete residential address is required' });
    }
    if (
      !card.holderName ||
      !card.number ||
      !card.expiryMonth ||
      !card.expiryYear ||
      !card.cvv ||
      !card.accountExpiryMonth ||
      !card.accountExpiryYear
    ) {
      return res.status(400).json({ message: 'Complete card and account expiry details are required' });
    }
    if (!isExpiryCurrentOrFuture(card.expiryMonth, card.expiryYear)) {
      return res.status(400).json({ message: 'Card expiry must be the current month or a future date' });
    }
    if (!isExpiryCurrentOrFuture(card.accountExpiryMonth, card.accountExpiryYear)) {
      return res.status(400).json({ message: 'Account expiry must be the current month or a future date' });
    }

    const duplicate = await assertUniqueCardCombo(User, card.number, card.cvv, user._id);
    if (duplicate) {
      return res.status(409).json({ message: duplicate });
    }

    const isFirstApplication =
      !user.accountNumber &&
      user.accountStatus !== 'under_review' &&
      user.accountStatus !== 'active' &&
      user.accountStatus !== 'approved';

    const previousControls = user.card?.controls || {};
    user.address = {
      line1: String(address.line1).trim(),
      line2: String(address.line2 || '').trim(),
      city: String(address.city).trim(),
      state: String(address.state).trim(),
      postalCode: String(address.postalCode).trim(),
      country: String(address.country).trim()
    };
    const sealed = sealCardSecrets({
      holderName: String(card.holderName).trim(),
      number: normalizeCardNumber(card.number),
      expiryMonth: String(card.expiryMonth),
      expiryYear: String(card.expiryYear),
      cvv: String(card.cvv).replace(/\D/g, ''),
      brand: String(card.brand || 'visa').toLowerCase(),
      accountType: String(card.accountType || 'personal').toLowerCase(),
      accountExpiryMonth: String(card.accountExpiryMonth),
      accountExpiryYear: String(card.accountExpiryYear),
      status: user.card?.status === 'active' ? 'active' : 'pending',
      controls: {
        frozen: !!previousControls.frozen,
        onlinePayments: previousControls.onlinePayments !== false,
        contactless: previousControls.contactless !== false,
        international: !!previousControls.international,
        atmWithdrawals: previousControls.atmWithdrawals !== false
      }
    });
    user.card = sealed;
    if (!user.accountNumber) {
      user.accountStatus = 'under_review';
    }
    await user.save();

    if (isFirstApplication) {
      await notify(
        user._id,
        'account',
        'Application submitted',
        'Your account & card request is under manager review.',
        '/settings?tab=banking'
      );
      try {
        const reviewers = await User.find({
          $or: [
            { role: 'manager', staffStatus: 'active' },
            { isSuperAdmin: true, staffStatus: 'active' }
          ]
        }).select('_id isSuperAdmin');
        await Promise.all(
          reviewers.map((staff) =>
            Notification.create({
              user: staff._id,
              kind: 'account',
              title: 'New account opening request',
              body: `${user.fullName} submitted an account & card application for review.`,
              href: staff.isSuperAdmin ? '/admin/requests' : '/manager/approvals',
              read: false
            }).catch(() => null)
          )
        );
      } catch (error) {
        console.warn('Staff application notify failed:', error.message);
      }
    }

    return res.status(201).json({
      message: isFirstApplication
        ? 'Application submitted for manager review.'
        : 'Card & address updated.',
      user: user.toSafeJSON()
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        message: 'This Card Number + CVV combination is already registered to another customer'
      });
    }
    console.error('Application error:', error);
    return res.status(500).json({ message: 'Unable to submit application' });
  }
});

router.patch('/card-controls', async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user?.card) {
      return res.status(400).json({ message: 'Add card details before configuring controls' });
    }
    user.card.controls = user.card.controls || {};
    ['frozen', 'onlinePayments', 'contactless', 'international', 'atmWithdrawals'].forEach((key) => {
      if (typeof req.body[key] === 'boolean') {
        user.card.controls[key] = req.body[key];
      }
    });
    if (user.card.controls.frozen) {
      user.card.status = 'frozen';
    } else if (user.card.status === 'frozen') {
      user.card.status = user.accountNumber ? 'active' : 'pending';
    }
    await user.save();
    await notify(
      user._id,
      'security',
      'Card controls updated',
      user.card.controls.frozen
        ? 'Your ATM card is frozen. All money movement is paused until you unfreeze it.'
        : 'Card controls saved. Online, contactless, international, and ATM flags are enforced on money APIs.',
      '/settings?tab=cardinfo'
    );
    return res.json({ message: 'Card controls updated', user: user.toSafeJSON() });
  } catch (error) {
    console.error('Card controls error:', error);
    return res.status(500).json({ message: 'Unable to update card controls' });
  }
});

router.post('/limits/request', async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Account not found' });
    }
    if (user.pendingLimitRequest?.status === 'pending') {
      return res.status(400).json({ message: 'A limit change request is already pending manager review' });
    }
    const proposed = {
      depositDaily: Number(req.body.depositDaily),
      withdrawDaily: Number(req.body.withdrawDaily),
      transferDaily: Number(req.body.transferDaily),
      transferCountDaily: Number(req.body.transferCountDaily)
    };
    if (
      !proposed.depositDaily ||
      proposed.depositDaily <= 0 ||
      !proposed.withdrawDaily ||
      proposed.withdrawDaily <= 0 ||
      !proposed.transferDaily ||
      proposed.transferDaily <= 0 ||
      !proposed.transferCountDaily ||
      proposed.transferCountDaily < 1
    ) {
      return res.status(400).json({ message: 'Enter valid positive limit values' });
    }
    user.pendingLimitRequest = {
      status: 'pending',
      requestedAt: new Date(),
      decidedAt: null,
      reviewNote: null,
      proposed
    };
    await user.save();
    await notify(
      user._id,
      'account',
      'Limit change submitted',
      'Your daily limit request is waiting for manager approval.',
      '/settings?tab=limits'
    );
    try {
      const managers = await User.find({
        $or: [{ role: 'manager', staffStatus: 'active' }, { isSuperAdmin: true, staffStatus: 'active' }]
      }).select('_id isSuperAdmin');
      await Promise.all(
        managers.map((staff) =>
          Notification.create({
            user: staff._id,
            kind: 'account',
            title: 'Limit change request',
            body: `${user.fullName} requested new 24-hour deposit / withdraw / transfer limits.`,
            href: staff.isSuperAdmin ? '/manager/limits' : '/manager/limits',
            read: false
          }).catch(() => null)
        )
      );
    } catch (error) {
      console.warn('Limit request staff notify failed:', error.message);
    }
    return res.status(201).json({
      message: 'Limit change submitted for manager approval.',
      user: user.toSafeJSON()
    });
  } catch (error) {
    console.error('Limit request error:', error);
    return res.status(500).json({ message: 'Unable to submit limit request' });
  }
});

module.exports = router;
