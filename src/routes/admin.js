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
    const scope = String(req.query.scope || '').toLowerCase();
    const roleFilter = String(req.query.role || '').toLowerCase();

    // Super Admin can list all roles; managers/admins default to customers only.
    let filter;
    if (req.user?.isSuperAdmin && (scope === 'all' || roleFilter === 'all')) {
      filter = {};
    } else if (req.user?.isSuperAdmin && ['customer', 'manager', 'admin'].includes(roleFilter)) {
      filter = { role: roleFilter };
    } else {
      filter = {
        $or: [{ role: 'customer' }, { role: { $exists: false } }, { role: null }]
      };
    }

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

router.get('/customers/:id/transactions', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    let Transaction;
    try {
      Transaction = require('../models/Transaction');
    } catch {
      return res.json({ items: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
    }
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const type = String(req.query.type || '');
    const filter = { user: user._id };
    if (['deposit', 'withdraw', 'transfer_in', 'transfer_out'].includes(type)) {
      filter.type = type;
    }
    const [items, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Transaction.countDocuments(filter)
    ]);
    return res.json({
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1
      }
    });
  } catch (error) {
    console.error('Admin customer transactions error:', error);
    return res.status(500).json({ message: 'Unable to load customer transactions' });
  }
});

router.get('/requests', async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const filter = {
      $or: [{ role: 'customer' }, { role: { $exists: false } }, { role: null }]
    };
    if (status && status !== 'all') {
      filter.accountStatus = status;
    } else {
      filter.accountStatus = {
        $in: ['under_review', 'active', 'approved', 'rejected', 'address_required', 'blocked', 'deactivated']
      };
    }
    const users = await User.find(filter).sort({ updatedAt: -1 }).limit(150);
    return res.json({
      items: users.map((u) => {
        const safe = u.toSafeJSON();
        return {
          id: safe.id,
          userId: safe.id,
          fullName: safe.fullName,
          email: safe.email,
          submittedAt: u.updatedAt,
          status: u.accountStatus,
          address: safe.address || null,
          card: safe.card || null
        };
      })
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
      body: `Your NovaBank account is now ${status.replace(/_/g, ' ')}.`,
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

/** Super Admin — full staff directory (pending / active / rejected) */
router.get('/staff', requireSuperAdmin, async (req, res) => {
  try {
    const status = String(req.query.status || 'all').toLowerCase();
    const filter = {
      role: { $in: ['manager', 'admin'] },
      isSuperAdmin: { $ne: true }
    };
    if (status && status !== 'all') {
      filter.staffStatus = status;
    }
    const users = await User.find(filter).sort({ createdAt: -1 }).limit(200);
    return res.json({ items: users.map((u) => u.toSafeJSON()) });
  } catch (error) {
    console.error('Staff list error:', error);
    return res.status(500).json({ message: 'Unable to load staff directory' });
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
    await Notification.create({
      user: user._id,
      kind: 'admin',
      title: 'Staff access declined',
      body: 'Your NovaBank staff registration was not approved. Contact your Super Admin for next steps.',
      href: '/auth/staff-status',
      read: false
    });
    return res.json({ message: 'Staff registration rejected', user: user.toSafeJSON() });
  } catch (error) {
    console.error('Staff reject error:', error);
    return res.status(500).json({ message: 'Unable to reject staff user' });
  }
});

function requireManagerOrSuperAdmin(req, res, next) {
  if (req.user?.role === 'manager' || req.user?.isSuperAdmin) {
    return next();
  }
  return res.status(403).json({
    message: 'Manager access required for limit approvals (Super Admin override allowed)'
  });
}

router.get('/limit-requests', requireManagerOrSuperAdmin, async (_req, res) => {
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

router.post('/limit-requests/:userId/approve', requireManagerOrSuperAdmin, async (req, res) => {
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

router.post('/limit-requests/:userId/reject', requireManagerOrSuperAdmin, async (req, res) => {
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
    const staffFilter = {
      role: { $in: ['manager', 'admin'] },
      isSuperAdmin: { $ne: true }
    };
    const [total, active, underReview, blocked, managers, admins, staffPending] = await Promise.all([
      User.countDocuments(customerFilter),
      User.countDocuments({ ...customerFilter, accountStatus: { $in: ['active', 'approved'] } }),
      User.countDocuments({ ...customerFilter, accountStatus: 'under_review' }),
      User.countDocuments({ ...customerFilter, accountStatus: { $in: ['blocked', 'deactivated'] } }),
      User.countDocuments({ role: 'manager', isSuperAdmin: { $ne: true } }),
      User.countDocuments({ role: 'admin', isSuperAdmin: { $ne: true } }),
      User.countDocuments({ ...staffFilter, staffStatus: 'pending_approval' })
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
      staff: { managers, admins, pending: staffPending },
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
