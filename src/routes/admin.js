const express = require('express');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { generateAccountNumber } = require('../utils/helpers');

const router = express.Router();

router.use(auth);

function requireStaff(req, res, next) {
  const role = req.user?.role || 'customer';
  if (role !== 'admin' && role !== 'manager') {
    return res.status(403).json({ message: 'Manager or admin access required' });
  }
  return next();
}

router.use(requireStaff);

router.get('/customers', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '5'), 10) || 5));
    const filter = {
      $or: [{ role: 'customer' }, { role: { $exists: false } }, { role: null }]
    };

    const total = await User.countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, pages);
    const skip = (safePage - 1) * limit;

    const users = await User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);
    return res.json({
      items: users.map((u) => u.toSafeJSON()),
      pagination: {
        page: safePage,
        limit,
        total,
        pages
      }
    });
  } catch (error) {
    console.error('Admin list customers error:', error);
    return res.status(500).json({ message: 'Unable to load customers' });
  }
});

router.get('/customers/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    return res.json({ user: user.toSafeJSON() });
  } catch (error) {
    console.error('Admin get customer error:', error);
    return res.status(500).json({ message: 'Unable to load customer' });
  }
});

router.get('/requests', async (_req, res) => {
  try {
    const users = await User.find({ accountStatus: 'under_review' }).sort({ updatedAt: -1 }).limit(100);
    return res.json({
      items: users.map((u) => ({
        id: u._id.toString(),
        userId: u._id.toString(),
        fullName: u.fullName,
        email: u.email,
        submittedAt: u.updatedAt,
        status: u.accountStatus,
        address: u.address || null,
        card: u.card || null
      }))
    });
  } catch (error) {
    console.error('Admin list requests error:', error);
    return res.status(500).json({ message: 'Unable to load opening requests' });
  }
});

router.patch('/customers/:id/status', async (req, res) => {
  try {
    const status = String(req.body.status || '').trim();
    const allowed = ['active', 'blocked', 'deactivated', 'under_review', 'rejected', 'address_required'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid account status' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    user.accountStatus = status;
    await user.save();

    await Notification.create({
      user: user._id,
      kind: 'admin',
      title: 'Account status updated',
      body: `Your NovaBank account is now ${status}.`,
      href: '/settings?tab=banking',
      read: false
    });

    return res.json({ message: `Status updated to ${status}`, user: user.toSafeJSON() });
  } catch (error) {
    console.error('Admin set status error:', error);
    return res.status(500).json({ message: 'Unable to update status' });
  }
});

router.delete('/customers/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    await Notification.deleteMany({ user: user._id });
    await user.deleteOne();
    return res.json({ message: 'Customer removed' });
  } catch (error) {
    console.error('Admin delete customer error:', error);
    return res.status(500).json({ message: 'Unable to delete customer' });
  }
});

router.post('/requests/:userId/approve', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    if (user.accountStatus !== 'under_review' && user.accountStatus !== 'address_required') {
      // Allow re-approve path for demo, but require card/address present
      if (!user.address || !user.card) {
        return res.status(400).json({ message: 'Customer has no submitted application details' });
      }
    }

    if (!user.accountNumber) {
      let accountNumber = generateAccountNumber();
      // Ensure unique
      // eslint-disable-next-line no-await-in-loop
      while (await User.findOne({ accountNumber })) {
        accountNumber = generateAccountNumber();
      }
      user.accountNumber = accountNumber;
    }

    user.accountStatus = 'active';
    if (user.card) {
      user.card.status = 'active';
    }
    await user.save();

    const masked = `••••${String(user.accountNumber).slice(-4)}`;
    await Notification.create({
      user: user._id,
      kind: 'account',
      title: 'Account approved',
      body: `Your account ${masked} is active. Deposit, withdraw, and transfer are unlocked.`,
      href: '/dashboard',
      read: false
    });

    return res.json({
      message: 'Application approved and account number issued.',
      user: user.toSafeJSON()
    });
  } catch (error) {
    console.error('Admin approve error:', error);
    return res.status(500).json({ message: 'Unable to approve application' });
  }
});

router.post('/requests/:userId/reject', async (req, res) => {
  try {
    const note = String(req.body.reviewNote || 'Additional verification required.').trim();
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    user.accountStatus = 'rejected';
    await user.save();

    await Notification.create({
      user: user._id,
      kind: 'account',
      title: 'Application rejected',
      body: note,
      href: '/settings?tab=cardinfo',
      read: false
    });

    return res.json({ message: 'Application rejected', user: user.toSafeJSON() });
  } catch (error) {
    console.error('Admin reject error:', error);
    return res.status(500).json({ message: 'Unable to reject application' });
  }
});

function requireSuperAdmin(req, res, next) {
  if (!req.user?.isSuperAdmin) {
    return res.status(403).json({ message: 'Super Admin access required' });
  }
  return next();
}

router.get('/staff-pending', requireSuperAdmin, async (_req, res) => {
  try {
    const users = await User.find({
      role: { $in: ['manager', 'admin'] },
      isSuperAdmin: { $ne: true },
      staffStatus: 'pending_approval'
    }).sort({ createdAt: -1 });
    return res.json({ items: users.map((u) => u.toSafeJSON()) });
  } catch (error) {
    console.error('Staff pending error:', error);
    return res.status(500).json({ message: 'Unable to load pending staff' });
  }
});

router.post('/staff/:userId/approve', requireSuperAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user || !['manager', 'admin'].includes(user.role || '')) {
      return res.status(404).json({ message: 'Staff user not found' });
    }
    user.staffStatus = 'active';
    await user.save();
    await Notification.create({
      user: user._id,
      kind: 'admin',
      title: 'Staff access approved',
      body: 'Your NovaBank staff portal is active. You can sign in now.',
      href: '/auth/login',
      read: false
    });
    return res.json({ message: 'Staff user activated', user: user.toSafeJSON() });
  } catch (error) {
    console.error('Staff approve error:', error);
    return res.status(500).json({ message: 'Unable to approve staff user' });
  }
});

router.post('/staff/:userId/reject', requireSuperAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user || !['manager', 'admin'].includes(user.role || '')) {
      return res.status(404).json({ message: 'Staff user not found' });
    }
    user.staffStatus = 'rejected';
    await user.save();
    return res.json({ message: 'Staff registration rejected', user: user.toSafeJSON() });
  } catch (error) {
    console.error('Staff reject error:', error);
    return res.status(500).json({ message: 'Unable to reject staff user' });
  }
});

router.get('/limit-requests', async (_req, res) => {
  try {
    const users = await User.find({
      role: 'customer',
      'pendingLimitRequest.status': 'pending'
    }).sort({ 'pendingLimitRequest.requestedAt': -1 });
    return res.json({
      items: users.map((u) => ({
        ...u.toSafeJSON(),
        pendingLimitRequest: u.pendingLimitRequest
      }))
    });
  } catch (error) {
    console.error('Limit requests error:', error);
    return res.status(500).json({ message: 'Unable to load limit requests' });
  }
});

router.post('/limit-requests/:userId/approve', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user?.pendingLimitRequest || user.pendingLimitRequest.status !== 'pending') {
      return res.status(404).json({ message: 'No pending limit request' });
    }
    const proposed = user.pendingLimitRequest.proposed || {};
    user.limits = {
      depositDaily: Number(proposed.depositDaily),
      withdrawDaily: Number(proposed.withdrawDaily),
      transferDaily: Number(proposed.transferDaily),
      transferCountDaily: Number(proposed.transferCountDaily)
    };
    user.pendingLimitRequest = {
      status: 'approved',
      requestedAt: user.pendingLimitRequest.requestedAt,
      decidedAt: new Date(),
      reviewNote: String(req.body.reviewNote || 'Approved').trim(),
      proposed
    };
    await user.save();
    await Notification.create({
      user: user._id,
      kind: 'account',
      title: 'Limit change approved',
      body: 'Your new daily deposit, withdraw, and transfer limits are active.',
      href: '/settings?tab=limits',
      read: false
    });
    return res.json({ message: 'Limit request approved', user: user.toSafeJSON() });
  } catch (error) {
    console.error('Limit approve error:', error);
    return res.status(500).json({ message: 'Unable to approve limit request' });
  }
});

router.post('/limit-requests/:userId/reject', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user?.pendingLimitRequest || user.pendingLimitRequest.status !== 'pending') {
      return res.status(404).json({ message: 'No pending limit request' });
    }
    user.pendingLimitRequest = {
      status: 'rejected',
      requestedAt: user.pendingLimitRequest.requestedAt,
      decidedAt: new Date(),
      reviewNote: String(req.body.reviewNote || 'Not approved').trim(),
      proposed: user.pendingLimitRequest.proposed
    };
    await user.save();
    await Notification.create({
      user: user._id,
      kind: 'account',
      title: 'Limit change rejected',
      body: user.pendingLimitRequest.reviewNote,
      href: '/settings?tab=limits',
      read: false
    });
    return res.json({ message: 'Limit request rejected', user: user.toSafeJSON() });
  } catch (error) {
    console.error('Limit reject error:', error);
    return res.status(500).json({ message: 'Unable to reject limit request' });
  }
});

router.get('/analytics', async (_req, res) => {
  try {
    let Transaction;
    try {
      Transaction = require('../models/Transaction');
    } catch {
      return res.json({
        customers: { total: 0, active: 0, underReview: 0, blocked: 0 },
        volumeByType: [],
        dailyFlow: []
      });
    }

    const customerFilter = {
      $or: [{ role: 'customer' }, { role: { $exists: false } }, { role: null }]
    };
    const [total, active, underReview, blocked] = await Promise.all([
      User.countDocuments(customerFilter),
      User.countDocuments({ ...customerFilter, accountStatus: { $in: ['active', 'approved'] } }),
      User.countDocuments({ ...customerFilter, accountStatus: 'under_review' }),
      User.countDocuments({ ...customerFilter, accountStatus: { $in: ['blocked', 'deactivated'] } })
    ]);

    const since = new Date();
    since.setDate(since.getDate() - 13);
    since.setHours(0, 0, 0, 0);

    const volumeByType = await Transaction.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } }
    ]);

    const dailyFlow = await Transaction.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: {
            day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            type: '$type'
          },
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.day': 1 } }
    ]);

    return res.json({
      customers: { total, active, underReview, blocked },
      volumeByType: volumeByType.map((row) => ({
        type: row._id,
        total: row.total,
        count: row.count
      })),
      dailyFlow: dailyFlow.map((row) => ({
        day: row._id.day,
        type: row._id.type,
        total: row.total,
        count: row.count
      }))
    });
  } catch (error) {
    console.error('Analytics error:', error);
    return res.status(500).json({ message: 'Unable to load analytics' });
  }
});

module.exports = router;
