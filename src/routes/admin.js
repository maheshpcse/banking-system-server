const express = require('express');
const auth = require('../middleware/auth');
const User = require('../models/User');
const { notifyUser, notifyAccountContact } = require('../services/notify-channels');
const { generateAccountNumber } = require('../utils/helpers');
const {
  hydrateUser,
  hydrateUsers,
  accountNumberExists,
  writeAudit
} = require('../services/user-domain');

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
    const statusFilter = String(req.query.status || '').trim().toLowerCase();
    const loginStatusFilter = String(req.query.loginStatus || '').trim().toLowerCase();
    const bankingStatusFilter = String(
      req.query.bankingStatus || req.query.accountStatus || ''
    )
      .trim()
      .toLowerCase();
    const allowedBankingStatus = [
      'pending',
      'address_required',
      'under_review',
      'approved',
      'active',
      'rejected',
      'blocked',
      'suspended',
      'deactivated',
      'deleted'
    ];
    const allowedLoginStatus = ['active', 'blocked', 'deactivated', 'deleted'];

    // Super Admin can list all roles except the Super Admin seed account itself.
    let filter;
    if (req.user?.isSuperAdmin && (scope === 'all' || roleFilter === 'all')) {
      filter = { isSuperAdmin: { $ne: true } };
    } else if (req.user?.isSuperAdmin && ['customer', 'manager', 'admin'].includes(roleFilter)) {
      filter = { role: roleFilter, isSuperAdmin: { $ne: true } };
    } else {
      filter = {
        $or: [{ role: 'customer' }, { role: { $exists: false } }, { role: null }]
      };
    }

    if (loginStatusFilter && loginStatusFilter !== 'all' && allowedLoginStatus.includes(loginStatusFilter)) {
      filter = { ...filter, loginStatus: loginStatusFilter };
    }

    if (
      bankingStatusFilter &&
      bankingStatusFilter !== 'all' &&
      allowedBankingStatus.includes(bankingStatusFilter)
    ) {
      if (bankingStatusFilter === 'active') {
        filter = { ...filter, accountStatus: { $in: ['active', 'approved'] } };
      } else {
        filter = { ...filter, accountStatus: bankingStatusFilter };
      }
    } else if (statusFilter && statusFilter !== 'all' && allowedBankingStatus.includes(statusFilter)) {
      // Legacy `status` query — treat as banking/accountStatus for backward compat
      if (statusFilter === 'active') {
        filter = { ...filter, accountStatus: { $in: ['active', 'approved'] } };
      } else {
        filter = { ...filter, accountStatus: statusFilter };
      }
    }

    const total = await User.countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, pages);
    const skip = (safePage - 1) * limit;

    const users = await User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);
    await hydrateUsers(users);
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
    await hydrateUser(user);
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
        $in: [
          'under_review',
          'active',
          'approved',
          'rejected',
          'address_required',
          'blocked',
          'suspended',
          'deactivated'
        ]
      };
    }
    const users = await User.find(filter).sort({ updatedAt: -1 }).limit(150);
    await hydrateUsers(users);
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

async function applyLoginStatus(user, status, actorId) {
  user.loginStatus = status;
  await user.save();

  await writeAudit({
    actorId,
    targetUserId: user._id,
    action: 'account.login_status_update',
    meta: { status }
  });

  let title = 'Sign-in access updated';
  let body = `Your NovaBank sign-in access is now ${status}.`;
  if (status === 'blocked') {
    title = 'Sign-in blocked';
    body =
      'Your NovaBank sign-in access has been blocked by staff. You cannot sign in until a staff member restores access. Use Contact administrator (/auth/contact-admin) or contact NovaBank support if you need help.';
  } else if (status === 'deactivated') {
    title = 'Sign-in deactivated';
    body =
      'Your NovaBank sign-in access has been deactivated by staff. You cannot sign in until a staff member reactivates your account. Use Contact administrator (/auth/contact-admin) or contact NovaBank support if you need help.';
  } else if (status === 'active') {
    title = 'Sign-in restored';
    body = 'Your NovaBank sign-in access is active again. You can sign in at /auth/login.';
  }

  await notifyAccountContact(user, {
    kind: 'admin',
    title,
    body,
    href: status === 'active' ? '/auth/login' : '/auth/contact-admin'
  });
}

async function applyBankingStatus(user, status, actorId) {
  user.accountStatus = status;
  await user.save();

  await writeAudit({
    actorId,
    targetUserId: user._id,
    action: 'account.banking_status_update',
    meta: { status }
  });

  const loginActive = (user.loginStatus || 'active') === 'active';
  const stillSignInHint = loginActive
    ? ' You can still sign in. Use Contact administrator (/auth/contact-admin) to request banking access restoration.'
    : ' Use Contact administrator (/auth/contact-admin) if you need help.';

  let title = 'Banking status updated';
  let body = `Your NovaBank banking account status is now ${status.replace(/_/g, ' ')}.`;
  if (status === 'blocked') {
    title = 'Banking account blocked';
    body = `Your NovaBank banking account has been blocked by staff. Transfers and other money movement are unavailable.${stillSignInHint}`;
  } else if (status === 'suspended') {
    title = 'Banking account suspended';
    body = `Your NovaBank banking account has been suspended by staff. Transfers and other money movement are unavailable.${stillSignInHint}`;
  } else if (status === 'deactivated') {
    title = 'Banking account deactivated';
    body = `Your NovaBank banking account has been deactivated by staff. Transfers and other money movement are unavailable.${stillSignInHint}`;
  } else if (status === 'active') {
    title = 'Banking account restored';
    body =
      'Your NovaBank banking account is active again. You can use deposits, withdrawals, and transfers as usual.';
  }

  await notifyAccountContact(user, {
    kind: 'admin',
    title,
    body,
    href: '/settings?tab=banking'
  });
}

router.patch('/customers/:id/login-status', async (req, res) => {
  try {
    const status = String(req.body.status || '').trim();
    const allowed = ['active', 'blocked', 'deactivated'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid login status' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    await hydrateUser(user);

    await applyLoginStatus(user, status, req.user._id);
    return res.json({ message: `Login status updated to ${status}`, user: user.toSafeJSON() });
  } catch (error) {
    console.error('Admin set login status error:', error);
    return res.status(500).json({ message: 'Unable to update login status' });
  }
});

router.patch('/customers/:id/banking-status', async (req, res) => {
  try {
    const status = String(req.body.status || '').trim();
    const allowed = [
      'active',
      'blocked',
      'suspended',
      'deactivated',
      'under_review',
      'rejected',
      'address_required'
    ];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid banking status' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    await hydrateUser(user);

    await applyBankingStatus(user, status, req.user._id);
    return res.json({ message: `Banking status updated to ${status}`, user: user.toSafeJSON() });
  } catch (error) {
    console.error('Admin set banking status error:', error);
    return res.status(500).json({ message: 'Unable to update banking status' });
  }
});

/**
 * @deprecated Prefer PATCH /customers/:id/login-status or /banking-status.
 * If body.axis === 'banking' → banking status; otherwise → login status
 * (backward compat for old clients that sent blocked|deactivated|active).
 */
router.patch('/customers/:id/status', async (req, res) => {
  try {
    const status = String(req.body.status || '').trim();
    const axis = String(req.body.axis || '').trim().toLowerCase();

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    await hydrateUser(user);

    if (axis === 'banking') {
      const allowed = [
        'active',
        'blocked',
        'suspended',
        'deactivated',
        'under_review',
        'rejected',
        'address_required'
      ];
      if (!allowed.includes(status)) {
        return res.status(400).json({ message: 'Invalid banking status' });
      }
      await applyBankingStatus(user, status, req.user._id);
      return res.json({ message: `Banking status updated to ${status}`, user: user.toSafeJSON() });
    }

    // Default / no axis: loginStatus (compat for active|blocked|deactivated)
    const loginAllowed = ['active', 'blocked', 'deactivated'];
    if (!loginAllowed.includes(status)) {
      // Older clients sometimes sent under_review / rejected / address_required via this route —
      // route those to banking when they are not valid login statuses.
      const bankingAllowed = [
        'under_review',
        'rejected',
        'address_required',
        'suspended',
        'blocked',
        'deactivated',
        'active'
      ];
      if (bankingAllowed.includes(status) && !loginAllowed.includes(status)) {
        await applyBankingStatus(user, status, req.user._id);
        return res.json({ message: `Banking status updated to ${status}`, user: user.toSafeJSON() });
      }
      return res.status(400).json({
        message:
          'Invalid status. Use axis: "login" or "banking", or call /login-status or /banking-status.'
      });
    }

    await applyLoginStatus(user, status, req.user._id);
    return res.json({ message: `Login status updated to ${status}`, user: user.toSafeJSON() });
  } catch (error) {
    console.error('Admin set status error:', error);
    return res.status(500).json({ message: 'Unable to update status' });
  }
});

router.post('/customers/:id/reset-login-attempts', async (req, res) => {
  try {
    if (!req.user?.isSuperAdmin) {
      return res.status(403).json({ message: 'Super Admin access required to reset login locks' });
    }
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    await hydrateUser(user);
    user.loginAttempts = { count: 0, lockedUntil: null, lastFailedAt: null };
    await user.save();
    await writeAudit({
      actorId: req.user._id,
      targetUserId: user._id,
      action: 'login.reset_attempts'
    });
    await notifyUser(user._id, {
      kind: 'security',
      title: 'Sign-in lock cleared',
      body: 'A Super Admin reset your failed sign-in counter. You can sign in again.',
      href: '/auth/login',
      forceEmail: true,
      forceSms: true
    }).catch(() => null);
    return res.json({ message: 'Login attempts reset', user: user.toSafeJSON() });
  } catch (error) {
    console.error('Reset login attempts error:', error);
    return res.status(500).json({ message: 'Unable to reset login attempts' });
  }
});

router.delete('/customers/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    if (user.isSuperAdmin) {
      return res.status(403).json({ message: 'Cannot delete the Super Admin account' });
    }
    if (user.loginStatus === 'deleted' || user.accountStatus === 'deleted') {
      if (user.loginStatus !== 'deleted' || user.accountStatus !== 'deleted') {
        user.loginStatus = 'deleted';
        user.accountStatus = 'deleted';
        await user.save();
      }
      return res.json({ message: 'Customer already deleted', user: user.toSafeJSON() });
    }

    await notifyAccountContact(user, {
      kind: 'admin',
      title: 'Account deleted',
      body:
        'Your NovaBank account was deleted by staff. You can no longer sign in with these credentials. To use NovaBank again, please create a new account with the same email or username.',
      href: '/auth/register'
    }).catch(() => null);

    user.loginStatus = 'deleted';
    user.accountStatus = 'deleted';
    await user.save();

    await writeAudit({
      actorId: req.user._id,
      targetUserId: user._id,
      action: 'customer.soft_delete',
      meta: { email: user.email, username: user.username }
    });

    return res.json({ message: 'Customer account deleted', user: user.toSafeJSON() });
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
    await hydrateUser(user);
    if (user.accountStatus !== 'under_review' && user.accountStatus !== 'address_required') {
      // Allow re-approve path for demo, but require card/address present
      if (!user.address || !user.card) {
        return res.status(400).json({ message: 'Customer has no submitted application details' });
      }
    }

    if (!user.accountNumber) {
      let accountNumber = generateAccountNumber();
      // Ensure unique across User embeds and Account collection
      // eslint-disable-next-line no-await-in-loop
      while (await accountNumberExists(accountNumber)) {
        accountNumber = generateAccountNumber();
      }
      user.accountNumber = accountNumber;
    }

    user.accountStatus = 'active';
    if (user.card) {
      user.card.status = 'active';
      user.markModified('card');
    }
    await user.save();

    await writeAudit({
      actorId: req.user._id,
      targetUserId: user._id,
      action: 'application.approve',
      meta: { accountNumber: user.accountNumber }
    });

    const masked = `••••${String(user.accountNumber).slice(-4)}`;
    await notifyUser(user._id, {
      kind: 'account',
      title: 'Account approved',
      body: `Your account ${masked} is active. Deposit, withdraw, and transfer are unlocked.`,
      href: '/dashboard',
      forceEmail: true
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
    await hydrateUser(user);

    user.accountStatus = 'rejected';
    await user.save();

    await writeAudit({
      actorId: req.user._id,
      targetUserId: user._id,
      action: 'application.reject',
      meta: { note }
    });

    await notifyUser(user._id, {
      kind: 'account',
      title: 'Application rejected',
      body: note,
      href: '/settings?tab=cardinfo',
      forceEmail: true
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
    await hydrateUsers(users);
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
    await hydrateUsers(users);
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
    await writeAudit({
      actorId: req.user._id,
      targetUserId: user._id,
      action: 'staff.approve',
      meta: { role: user.role }
    });
    await notifyUser(user._id, {
      kind: 'admin',
      title: 'Staff access approved',
      body: 'Your NovaBank staff portal is active. You can sign in now.',
      href: '/auth/login',
      forceEmail: true
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
    await writeAudit({
      actorId: req.user._id,
      targetUserId: user._id,
      action: 'staff.reject',
      meta: { role: user.role }
    });
    await notifyUser(user._id, {
      kind: 'admin',
      title: 'Staff access declined',
      body: 'Your NovaBank staff registration was not approved. Contact your Super Admin for next steps.',
      href: '/auth/staff-status',
      forceEmail: true
    });
    return res.json({ message: 'Staff registration rejected', user: user.toSafeJSON() });
  } catch (error) {
    console.error('Staff reject error:', error);
    return res.status(500).json({ message: 'Unable to reject staff user' });
  }
});

router.patch('/staff/:userId/status', requireSuperAdmin, async (req, res) => {
  try {
    const status = String(req.body.status || '').trim();
    const allowed = ['blocked', 'deactivated', 'active'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid staff account status' });
    }

    const user = await User.findById(req.params.userId);
    if (!user || !['manager', 'admin'].includes(user.role || '')) {
      return res.status(404).json({ message: 'Staff user not found' });
    }
    if (user.isSuperAdmin) {
      return res.status(403).json({ message: 'Cannot change Super Admin account status' });
    }
    if (String(user._id) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot change your own account status' });
    }

    user.loginStatus = status;
    await user.save();

    await writeAudit({
      actorId: req.user._id,
      targetUserId: user._id,
      action: 'staff.status_update',
      meta: { status, role: user.role, axis: 'login' }
    });

    let title = 'Staff account status updated';
    let body = `Your NovaBank staff account is now ${status}.`;
    if (status === 'blocked') {
      title = 'Staff account blocked';
      body =
        'Your NovaBank staff account has been blocked by a Super Admin. You cannot sign in until access is restored. Contact your Super Admin for help.';
    } else if (status === 'deactivated') {
      title = 'Staff account deactivated';
      body =
        'Your NovaBank staff account has been deactivated by a Super Admin. You cannot sign in until access is restored. Contact your Super Admin for help.';
    } else if (status === 'active') {
      title = 'Staff account restored';
      body = 'Your NovaBank staff account is active again. You can sign in to the staff portal.';
    }

    await notifyAccountContact(user, {
      kind: 'admin',
      title,
      body,
      href: '/auth/login'
    });

    return res.json({ message: `Staff status updated to ${status}`, user: user.toSafeJSON() });
  } catch (error) {
    console.error('Staff status error:', error);
    return res.status(500).json({ message: 'Unable to update staff status' });
  }
});

router.delete('/staff/:userId', requireSuperAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user || !['manager', 'admin'].includes(user.role || '')) {
      return res.status(404).json({ message: 'Staff user not found' });
    }
    if (user.isSuperAdmin) {
      return res.status(403).json({ message: 'Cannot delete the Super Admin account' });
    }
    if (String(user._id) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }
    if (user.loginStatus === 'deleted' || user.accountStatus === 'deleted') {
      if (user.loginStatus !== 'deleted' || user.accountStatus !== 'deleted') {
        user.loginStatus = 'deleted';
        user.accountStatus = 'deleted';
        await user.save();
      }
      return res.json({ message: 'Staff account already deleted', user: user.toSafeJSON() });
    }

    await notifyAccountContact(user, {
      kind: 'admin',
      title: 'Staff account deleted',
      body:
        'Your NovaBank staff account was deleted by a Super Admin. You can no longer sign in. To request access again, register a new staff account with the same email or username.',
      href: '/auth/register-staff'
    }).catch(() => null);

    user.loginStatus = 'deleted';
    user.accountStatus = 'deleted';
    await user.save();

    await writeAudit({
      actorId: req.user._id,
      targetUserId: user._id,
      action: 'staff.soft_delete',
      meta: { email: user.email, username: user.username, role: user.role }
    });

    return res.json({ message: 'Staff account deleted', user: user.toSafeJSON() });
  } catch (error) {
    console.error('Staff delete error:', error);
    return res.status(500).json({ message: 'Unable to delete staff account' });
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

router.get('/limit-requests', requireManagerOrSuperAdmin, async (req, res) => {
  try {
    const statusRaw = String(req.query.status || 'pending')
      .trim()
      .toLowerCase();
    const allowed = ['pending', 'approved', 'rejected', 'all'];
    const status = allowed.includes(statusRaw) ? statusRaw : 'pending';
    const filter = { role: 'customer' };
    if (status === 'all') {
      filter['pendingLimitRequest.status'] = { $in: ['pending', 'approved', 'rejected'] };
    } else {
      filter['pendingLimitRequest.status'] = status;
    }
    const users = await User.find(filter).sort({
      'pendingLimitRequest.requestedAt': -1,
      'pendingLimitRequest.decidedAt': -1
    });
    await hydrateUsers(users);
    return res.json({
      status,
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
    if (!user) {
      return res.status(404).json({ message: 'No pending limit request' });
    }
    await hydrateUser(user);
    if (!user.pendingLimitRequest || user.pendingLimitRequest.status !== 'pending') {
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
    await writeAudit({
      actorId: req.user._id,
      targetUserId: user._id,
      action: 'limits.approve',
      meta: { proposed }
    });
    await notifyUser(user._id, {
      kind: 'account',
      title: 'Limit change approved',
      body: 'Your new daily deposit, withdraw, and transfer limits are active.',
      href: '/settings?tab=limits',
      forceEmail: true
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
    if (!user) {
      return res.status(404).json({ message: 'No pending limit request' });
    }
    await hydrateUser(user);
    if (!user.pendingLimitRequest || user.pendingLimitRequest.status !== 'pending') {
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
    await writeAudit({
      actorId: req.user._id,
      targetUserId: user._id,
      action: 'limits.reject'
    });
    await notifyUser(user._id, {
      kind: 'account',
      title: 'Limit change rejected',
      body: user.pendingLimitRequest.reviewNote,
      href: '/settings?tab=limits',
      forceEmail: true
    });
    return res.json({ message: 'Limit request rejected', user: user.toSafeJSON() });
  } catch (error) {
    console.error('Limit reject error:', error);
    return res.status(500).json({ message: 'Unable to reject limit request' });
  }
});

router.get('/analytics', async (req, res) => {
  try {
    let Transaction;
    try {
      Transaction = require('../models/Transaction');
    } catch {
      return res.json({
        customers: {
          total: 0,
          active: 0,
          underReview: 0,
          blocked: 0,
          loginBlocked: 0,
          bankingBlocked: 0
        },
        volumeByType: [],
        dailyFlow: []
      });
    }

    const customerFilter = {
      $or: [{ role: 'customer' }, { role: { $exists: false } }, { role: null }],
      loginStatus: { $ne: 'deleted' },
      accountStatus: { $ne: 'deleted' }
    };
    const staffFilter = {
      role: { $in: ['manager', 'admin'] },
      isSuperAdmin: { $ne: true },
      loginStatus: { $ne: 'deleted' },
      accountStatus: { $ne: 'deleted' }
    };
    const [
      total,
      active,
      underReview,
      blocked,
      loginBlocked,
      bankingBlocked,
      managers,
      admins,
      staffPending
    ] = await Promise.all([
      User.countDocuments(customerFilter),
      User.countDocuments({ ...customerFilter, accountStatus: { $in: ['active', 'approved'] } }),
      User.countDocuments({ ...customerFilter, accountStatus: 'under_review' }),
      // Legacy field — banking restricted (includes suspended)
      User.countDocuments({
        ...customerFilter,
        accountStatus: { $in: ['blocked', 'suspended', 'deactivated'] }
      }),
      User.countDocuments({ ...customerFilter, loginStatus: { $in: ['blocked', 'deactivated'] } }),
      User.countDocuments({
        ...customerFilter,
        accountStatus: { $in: ['blocked', 'suspended', 'deactivated'] }
      }),
      User.countDocuments({
        role: 'manager',
        isSuperAdmin: { $ne: true },
        loginStatus: { $ne: 'deleted' },
        accountStatus: { $ne: 'deleted' }
      }),
      User.countDocuments({
        role: 'admin',
        isSuperAdmin: { $ne: true },
        loginStatus: { $ne: 'deleted' },
        accountStatus: { $ne: 'deleted' }
      }),
      User.countDocuments({ ...staffFilter, staffStatus: 'pending_approval' })
    ]);

    const typeFilter = String(req.query.type || '').trim().toLowerCase();
    let since = new Date();
    let until = null;
    const fromRaw = String(req.query.from || '').trim();
    const toRaw = String(req.query.to || '').trim();
    if (fromRaw) {
      since = new Date(fromRaw);
      since.setHours(0, 0, 0, 0);
    } else {
      since.setDate(since.getDate() - 13);
      since.setHours(0, 0, 0, 0);
    }
    if (toRaw) {
      until = new Date(toRaw);
      until.setHours(23, 59, 59, 999);
    }

    const createdMatch = { createdAt: { $gte: since } };
    if (until) createdMatch.createdAt.$lte = until;
    if (typeFilter === 'deposit' || typeFilter === 'withdraw') {
      createdMatch.type = typeFilter;
    } else if (typeFilter === 'transfer') {
      createdMatch.type = { $in: ['transfer_in', 'transfer_out'] };
    }

    const volumeByType = await Transaction.aggregate([
      { $match: createdMatch },
      { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } }
    ]);

    const dailyFlow = await Transaction.aggregate([
      { $match: createdMatch },
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
      customers: {
        total,
        active,
        underReview,
        blocked,
        loginBlocked,
        bankingBlocked
      },
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
