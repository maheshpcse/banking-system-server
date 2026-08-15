const express = require('express');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { generateReference, roundMoney } = require('../utils/helpers');

const router = express.Router();

router.use(auth);

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

    return res.json({
      user: req.user.toSafeJSON(),
      recentTransactions: recent,
      monthly: {
        deposits: monthlyMap.deposit || { total: 0, count: 0 },
        withdrawals: monthlyMap.withdraw || { total: 0, count: 0 },
        transfersIn: monthlyMap.transfer_in || { total: 0, count: 0 },
        transfersOut: monthlyMap.transfer_out || { total: 0, count: 0 }
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

    if (user.balance < amount) {
      return res.status(400).json({ message: 'Insufficient balance' });
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

    if (sender.accountNumber === toAccountNumber) {
      return res.status(400).json({ message: 'You cannot transfer to your own account' });
    }

    const recipient = await User.findOne({ accountNumber: toAccountNumber });
    if (!recipient) {
      return res.status(404).json({ message: 'Recipient account not found' });
    }

    if (sender.balance < amount) {
      return res.status(400).json({ message: 'Insufficient balance' });
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

module.exports = router;
