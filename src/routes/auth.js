const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ContactAdminRequest = require('../models/ContactAdminRequest');
const auth = require('../middleware/auth');
const { hydrateUser } = require('../services/user-domain');
const { notifyManagers, notifySuperAdmins, sendEmail, sendSms } = require('../services/notify-channels');
const {
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  getSupportEmail,
  signToken,
  signResetToken,
  normalizeUsername,
  looksLikeEmail,
  findByIdentifier,
  findUserForOtp,
  maskDestination,
  hashOtp,
  effectiveLoginStatus,
  accountLifecycleBlock,
  staffAccessBlock,
  superAdminUseConsoleBlock,
  clearLoginOtp
} = require('../utils/auth-helpers');

const router = express.Router();

const THEMES = User.THEMES || ['daylight', 'midnight', 'sand', 'ocean', 'graphite', 'orchid', 'aurora', 'forest', 'ember', 'mist'];
const FONTS = User.FONTS || ['comfortable', 'compact', 'large', 'editorial', 'technical'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AED', 'JPY', 'CAD', 'AUD'];
const COLOR_MODES = ['light', 'dark'];
const AVATAR_PRESET_RE = /^(customer|manager|admin)\/preset-[0-9]{2}$/;

function isSoftDeleted(user) {
  return effectiveLoginStatus(user) === 'deleted' || user.accountStatus === 'deleted';
}

function loginRestrictedForSignup(user) {
  const status = effectiveLoginStatus(user);
  return status === 'blocked' || status === 'deactivated';
}

/**
 * Reclaim a soft-deleted user for register / register-staff, or report 409 conflicts.
 * Prefer email match; free username on a different deleted user when needed.
 * Blocked/deactivated loginStatus cannot be reclaimed — return lifecycle instead.
 */
async function resolveDeletedReclaim(cleanEmail, cleanUsername) {
  const byEmail = await User.findOne({ email: cleanEmail });
  const byUsername = await User.findOne({ username: cleanUsername });

  if (byEmail && !isSoftDeleted(byEmail)) {
    const lifecycle = accountLifecycleBlock(byEmail, 'signup');
    if (lifecycle && loginRestrictedForSignup(byEmail)) {
      return { lifecycle };
    }
    return { conflict: 'email' };
  }
  if (byUsername && !isSoftDeleted(byUsername)) {
    const lifecycle = accountLifecycleBlock(byUsername, 'signup');
    if (lifecycle && loginRestrictedForSignup(byUsername)) {
      return { lifecycle };
    }
    return { conflict: 'username' };
  }

  const target = byEmail || byUsername || null;
  if (!target) {
    return { create: true };
  }

  if (byUsername && String(byUsername._id) !== String(target._id)) {
    byUsername.username = `${String(byUsername.username || 'user').slice(0, 20)}.del.${Date.now()
      .toString(36)
      .slice(-6)}`;
    await byUsername.save();
  }

  if (byEmail && String(byEmail._id) !== String(target._id)) {
    byEmail.email = `deleted.${Date.now().toString(36)}.${byEmail.email}`;
    await byEmail.save();
  }

  return { reclaim: target };
}

function initialsFromName(fullName) {
  return String(fullName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

router.post('/register', async (req, res) => {
  try {
    const { fullName, username, email, password } = req.body;

    if (!fullName || !username || !email || !password) {
      return res.status(400).json({ message: 'Full name, username, email, and password are required' });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const cleanUsername = normalizeUsername(username);
    if (!/^[a-z0-9._-]{3,32}$/.test(cleanUsername)) {
      return res.status(400).json({
        message: 'Username must be 3–32 characters (letters, numbers, dots, underscores, hyphens)'
      });
    }

    const cleanEmail = String(email).toLowerCase().trim();
    const resolved = await resolveDeletedReclaim(cleanEmail, cleanUsername);
    if (resolved.lifecycle) {
      return res.status(403).json(resolved.lifecycle);
    }
    if (resolved.conflict === 'email') {
      return res.status(409).json({
        code: 'EMAIL_IN_USE',
        message: 'An active account already uses this email. Sign in, or use Forgot password if you need access.'
      });
    }
    if (resolved.conflict === 'username') {
      return res.status(409).json({
        code: 'USERNAME_IN_USE',
        message: 'An active account already uses this username. Choose a different username, or sign in instead.'
      });
    }

    const trimmedName = String(fullName).trim();
    const avatar = {
      style: 'mint',
      initials: initialsFromName(trimmedName)
    };

    if (resolved.reclaim) {
      const user = resolved.reclaim;
      user.fullName = trimmedName;
      user.username = cleanUsername;
      user.email = cleanEmail;
      user.password = password;
      user.loginStatus = 'active';
      user.accountStatus = 'address_required';
      user.role = 'customer';
      user.staffStatus = 'active';
      user.isSuperAdmin = false;
      user.loginAttempts = { count: 0, lockedUntil: null, lastFailedAt: null };
      user.avatar = { ...(user.avatar?.toObject?.() || user.avatar || {}), ...avatar };
      await user.save();

      return res.status(201).json({
        message: 'Account created successfully',
        user: user.toSafeJSON()
      });
    }

    const user = await User.create({
      fullName: trimmedName,
      username: cleanUsername,
      email: cleanEmail,
      password,
      accountNumber: null,
      loginStatus: 'active',
      accountStatus: 'address_required',
      role: 'customer',
      staffStatus: 'active',
      isSuperAdmin: false,
      balance: 0,
      avatar
    });

    return res.status(201).json({
      message: 'Account created successfully',
      user: user.toSafeJSON()
    });
  } catch (error) {
    console.error('Register error:', error);
    if (error && error.code === 11000) {
      return res.status(409).json({ message: 'Email or username already exists' });
    }
    return res.status(500).json({ message: 'Unable to register account' });
  }
});

/** Staff (manager/admin) signup — pending until Super Admin activates */
router.post('/register-staff', async (req, res) => {
  try {
    const { fullName, username, email, password, role } = req.body;
    const cleanRole = String(role || '').toLowerCase();
    if (!['manager', 'admin'].includes(cleanRole)) {
      return res.status(400).json({ message: 'Role must be manager or admin' });
    }
    if (!fullName || !username || !email || !password) {
      return res.status(400).json({ message: 'Full name, username, email, and password are required' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }
    const cleanUsername = normalizeUsername(username);
    if (!/^[a-z0-9._-]{3,32}$/.test(cleanUsername)) {
      return res.status(400).json({
        message: 'Username must be 3–32 characters (letters, numbers, dots, underscores, hyphens)'
      });
    }
    const cleanEmail = String(email).toLowerCase().trim();
    const resolved = await resolveDeletedReclaim(cleanEmail, cleanUsername);
    if (resolved.lifecycle) {
      return res.status(403).json(resolved.lifecycle);
    }
    if (resolved.conflict === 'email') {
      return res.status(409).json({
        code: 'EMAIL_IN_USE',
        message: 'An active account already uses this email. Sign in, or use Forgot password if you need access.'
      });
    }
    if (resolved.conflict === 'username') {
      return res.status(409).json({
        code: 'USERNAME_IN_USE',
        message: 'An active account already uses this username. Choose a different username, or sign in instead.'
      });
    }

    const trimmedName = String(fullName).trim();
    const avatar = {
      style: 'slate',
      initials: initialsFromName(trimmedName)
    };

    let user;
    if (resolved.reclaim) {
      user = resolved.reclaim;
      user.fullName = trimmedName;
      user.username = cleanUsername;
      user.email = cleanEmail;
      user.password = password;
      user.role = cleanRole;
      user.isSuperAdmin = false;
      user.staffStatus = 'pending_approval';
      user.loginStatus = 'active';
      user.accountStatus = 'active';
      user.loginAttempts = { count: 0, lockedUntil: null, lastFailedAt: null };
      user.avatar = { ...(user.avatar?.toObject?.() || user.avatar || {}), ...avatar };
      await user.save();
    } else {
      user = await User.create({
        fullName: trimmedName,
        username: cleanUsername,
        email: cleanEmail,
        password,
        role: cleanRole,
        isSuperAdmin: false,
        staffStatus: 'pending_approval',
        accountNumber: null,
        loginStatus: 'active',
        accountStatus: 'active',
        balance: 0,
        avatar
      });
    }

    await notifySuperAdmins(
      'admin',
      'New staff access request',
      `${user.fullName} registered as ${cleanRole} and is waiting for approval.`,
      '/admin/staff'
    );

    return res.status(201).json({
      message:
        'Staff registration received. A Super Admin must approve your access before you can sign in.',
      user: {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        role: user.role,
        staffStatus: user.staffStatus
      }
    });
  } catch (error) {
    console.error('Staff register error:', error);
    if (error && error.code === 11000) {
      return res.status(409).json({ message: 'Email or username already exists' });
    }
    return res.status(500).json({ message: 'Unable to register staff account' });
  }
});

/** Public status check for pending staff (no auth) */
router.post('/staff-status', async (req, res) => {
  try {
    const identifier = req.body.identifier || req.body.email || req.body.username;
    if (!identifier) {
      return res.status(400).json({ message: 'Enter your username or email' });
    }
    const user = await findByIdentifier(identifier);
    if (!user || !['manager', 'admin'].includes(user.role || '')) {
      return res.status(404).json({ message: 'No staff registration found for that username or email' });
    }
    const status = user.isSuperAdmin ? 'active' : user.staffStatus || 'active';
    let title = 'Access ready';
    let detail =
      'Your staff profile is active. Sign in with the shared NovaBank login to open your portal.';
  if (status === 'pending_approval') {
      title = 'Access under verification';
      detail =
        'Your NovaBank staff credentials are locked until a Super Admin completes identity review. Typical activation finishes within 24 hours. Check back here anytime — once approved, you can sign in immediately with the same username.';
    } else if (status === 'rejected') {
      title = 'Staff access declined';
      detail =
        'This registration was not approved for portal access. Contact your NovaBank Super Admin with the username you registered so they can clarify next steps or invite a fresh request.';
    } else {
      title = 'Staff access active';
      detail =
        'Your manager/admin account is approved and ready. Sign in with your username or email to open the staff portal.';
    }
    return res.json({
      found: true,
      role: user.role,
      staffStatus: status,
      title,
      detail,
      canLogin: status === 'active'
    });
  } catch (error) {
    console.error('Staff status error:', error);
    return res.status(500).json({ message: 'Unable to check staff status' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const identifier = req.body.identifier || req.body.email || req.body.username;
    const { password } = req.body;
    const MAX_ATTEMPTS = 5;
    const LOCK_MS = 15 * 60 * 1000;

    if (!identifier || !password) {
      return res.status(400).json({ message: 'Username/email and password are required' });
    }

    const user = await findByIdentifier(identifier);
    if (!user) {
      return res.status(401).json({ message: 'Invalid username/email or password' });
    }
    await hydrateUser(user);

    const lockedUntil = user.loginAttempts?.lockedUntil
      ? new Date(user.loginAttempts.lockedUntil).getTime()
      : 0;
    if (lockedUntil && lockedUntil > Date.now()) {
      const mins = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60000));
      return res.status(429).json({
        code: 'LOGIN_LOCKED',
        message: `Too many failed sign-in attempts. Try again in about ${mins} minute(s), or ask a Super Admin to reset your lock.`
      });
    }
    if (lockedUntil && lockedUntil <= Date.now()) {
      user.loginAttempts = { count: 0, lockedUntil: null, lastFailedAt: null };
    }

    if (!(await user.comparePassword(password))) {
      const nextCount = (user.loginAttempts?.count || 0) + 1;
      user.loginAttempts = user.loginAttempts || {};
      user.loginAttempts.count = nextCount;
      user.loginAttempts.lastFailedAt = new Date();
      if (nextCount >= MAX_ATTEMPTS) {
        user.loginAttempts.lockedUntil = new Date(Date.now() + LOCK_MS);
        await user.save();
        return res.status(429).json({
          code: 'LOGIN_LOCKED',
          message:
            'You reached the maximum of 5 failed sign-in attempts. Access is paused for 15 minutes, or until a Super Admin resets it.'
        });
      }
      await user.save();
      const remaining = MAX_ATTEMPTS - nextCount;
      return res.status(401).json({
        code: 'LOGIN_FAILED',
        message: `Invalid username/email or password. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining before a temporary lock.`
      });
    }

    if (user.loginAttempts?.count || user.loginAttempts?.lockedUntil) {
      user.loginAttempts = { count: 0, lockedUntil: null, lastFailedAt: null };
      await user.save();
    }

    const lifecycle = accountLifecycleBlock(user);
    if (lifecycle) {
      return res.status(403).json(lifecycle);
    }

    if (user.isSuperAdmin) {
      return res.status(403).json(superAdminUseConsoleBlock());
    }

    const staffBlock = staffAccessBlock(user);
    if (staffBlock) {
      return res.status(403).json(staffBlock);
    }

    const token = signToken(user);
    return res.json({
      message: 'Login successful',
      token,
      user: user.toSafeJSON()
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ message: 'Unable to login' });
  }
});

router.post('/otp/request', async (req, res) => {
  try {
    const channel = String(req.body?.channel || '').trim().toLowerCase();
    const identifier = String(req.body?.identifier || '').trim();
    if (channel !== 'email' && channel !== 'phone') {
      return res.status(400).json({
        code: 'OTP_CHANNEL_INVALID',
        message: 'Choose email or phone for OTP sign-in.'
      });
    }
    if (!identifier || identifier.length < 3) {
      return res.status(400).json({
        code: 'OTP_IDENTIFIER_REQUIRED',
        message: channel === 'email' ? 'Enter your username or email.' : 'Enter your phone number.'
      });
    }

    const user = await findUserForOtp(channel, identifier);
    if (!user) {
      return res.status(404).json({
        code: 'OTP_USER_NOT_FOUND',
        message:
          channel === 'email'
            ? 'No account matches that username or email.'
            : 'No account matches that phone number.'
      });
    }
    await hydrateUser(user);

    const lifecycle = accountLifecycleBlock(user);
    if (lifecycle) {
      return res.status(403).json(lifecycle);
    }

    let destination = '';
    if (channel === 'email') {
      destination = String(user.email || '').trim().toLowerCase();
      if (!destination || !looksLikeEmail(destination)) {
        return res.status(400).json({
          code: 'OTP_CHANNEL_UNAVAILABLE',
          message: 'This account has no email on file for OTP sign-in.'
        });
      }
    } else {
      destination = String(user.phone || '').replace(/\D/g, '');
      if (destination.length < 8) {
        return res.status(400).json({
          code: 'OTP_CHANNEL_UNAVAILABLE',
          message: 'This account has no phone number on file for OTP sign-in.'
        });
      }
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    user.loginOtp = {
      codeHash: hashOtp(code),
      channel,
      destination,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      attempts: 0,
      sentAt: new Date()
    };
    await user.save();

    const brand = 'NovaBank';
    const body = `${brand} sign-in code: ${code}. It expires in 10 minutes.`;
    let delivered = false;
    let deliveryResult = null;
    try {
      if (channel === 'email') {
        deliveryResult = await sendEmail({
          to: destination,
          subject: `${brand} sign-in code`,
          text: body
        });
      } else {
        const e164 = destination.startsWith('+') ? destination : `+${destination}`;
        deliveryResult = await sendSms({ to: e164, body });
      }
      delivered = !!(deliveryResult && deliveryResult.sent && !deliveryResult.skipped);
    } catch (notifyError) {
      console.warn('OTP delivery fallback (logged only):', notifyError?.message || notifyError);
    }
    if (!delivered) {
      console.info(`[otp] ${channel} → ${destination}: ${code}`);
    }

    return res.json({
      message: 'OTP sent and will expire in 10 minutes.',
      expiresInMinutes: 10,
      channel,
      maskedDestination: maskDestination(channel, destination),
      delivered
    });
  } catch (error) {
    console.error('OTP request error:', error);
    return res.status(500).json({ message: 'Unable to send OTP' });
  }
});

router.post('/otp/verify', async (req, res) => {
  try {
    const channel = String(req.body?.channel || '').trim().toLowerCase();
    const identifier = String(req.body?.identifier || '').trim();
    const code = String(req.body?.code || '').trim();
    if (channel !== 'email' && channel !== 'phone') {
      return res.status(400).json({
        code: 'OTP_CHANNEL_INVALID',
        message: 'Choose email or phone for OTP sign-in.'
      });
    }
    if (!identifier || !code) {
      return res.status(400).json({
        code: 'OTP_REQUIRED',
        message: 'Enter the OTP code you received.'
      });
    }

    const user = await findUserForOtp(channel, identifier);
    if (!user?.loginOtp?.codeHash) {
      return res.status(400).json({
        code: 'OTP_NOT_FOUND',
        message: 'No active OTP found. Request a new code.'
      });
    }
    await hydrateUser(user);

    if (String(user.loginOtp.channel || '') !== channel) {
      return res.status(400).json({
        code: 'OTP_CHANNEL_MISMATCH',
        message: 'Request a new OTP for this sign-in method.'
      });
    }

    const expiresAt = user.loginOtp.expiresAt ? new Date(user.loginOtp.expiresAt).getTime() : 0;
    if (!expiresAt || expiresAt <= Date.now()) {
      clearLoginOtp(user);
      await user.save();
      return res.status(400).json({
        code: 'OTP_EXPIRED',
        message: 'This OTP has expired. Request a new code.'
      });
    }

    if ((user.loginOtp.attempts || 0) >= OTP_MAX_ATTEMPTS) {
      clearLoginOtp(user);
      await user.save();
      return res.status(429).json({
        code: 'OTP_LOCKED',
        message: 'Too many invalid OTP attempts. Request a new code.'
      });
    }

    if (hashOtp(code) !== user.loginOtp.codeHash) {
      user.loginOtp.attempts = (user.loginOtp.attempts || 0) + 1;
      await user.save();
      return res.status(401).json({
        code: 'OTP_INVALID',
        message: 'Invalid OTP. Check the code and try again.'
      });
    }

    const lifecycle = accountLifecycleBlock(user);
    if (lifecycle) {
      return res.status(403).json(lifecycle);
    }

    if (user.isSuperAdmin) {
      return res.status(403).json(superAdminUseConsoleBlock());
    }

    const staffBlock = staffAccessBlock(user);
    if (staffBlock) {
      return res.status(403).json(staffBlock);
    }

    clearLoginOtp(user);
    if (user.loginAttempts?.count || user.loginAttempts?.lockedUntil) {
      user.loginAttempts = { count: 0, lockedUntil: null, lastFailedAt: null };
    }
    await user.save();

    const token = signToken(user);
    return res.json({
      message: 'Login successful',
      token,
      user: user.toSafeJSON()
    });
  } catch (error) {
    console.error('OTP verify error:', error);
    return res.status(500).json({ message: 'Unable to verify OTP' });
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const identifier = req.body.identifier || req.body.email || req.body.username;
    if (!identifier) {
      return res.status(400).json({ message: 'Enter your username or email' });
    }

    const user = await findByIdentifier(identifier);
    if (!user) {
      return res.status(404).json({ message: 'No account found for that username or email' });
    }

    // Blocked / deactivated loginStatus cannot reset password. Soft-deleted accounts may continue
    // (same identity can re-register or complete reset before reclaim).
    const loginStatus = effectiveLoginStatus(user);
    if (loginStatus === 'blocked' || loginStatus === 'deactivated') {
      const lifecycle = accountLifecycleBlock(user, 'forgot');
      return res.status(403).json(lifecycle);
    }

    const resetToken = signResetToken(user);
    return res.json({
      message: 'Identity verified. You can set a new password.',
      resetToken,
      maskedEmail: user.email.replace(/(.{2}).+(@.+)/, '$1***$2'),
      username: user.username
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ message: 'Unable to verify account' });
  }
});

router.get('/support-info', (_req, res) => {
  return res.json({
    supportEmail: getSupportEmail(),
    contactPath: '/auth/contact-admin'
  });
});

/**
 * Public — blocked/deactivated login OR blocked/suspended/deactivated banking
 * users ask staff to restore access. One open request per user; notifies managers + Super Admins.
 */
router.post('/contact-admin', async (req, res) => {
  try {
    const identifier = String(req.body.identifier || req.body.email || req.body.username || '').trim();
    const message = String(req.body.message || '').trim().slice(0, 600);

    if (!identifier || identifier.length < 3) {
      return res.status(400).json({ message: 'Enter the username or email on your account' });
    }

    const user = await findByIdentifier(identifier);
    if (!user) {
      return res.status(404).json({
        message: 'No account found for that username or email.',
        supportEmail: getSupportEmail()
      });
    }
    await hydrateUser(user);

    const loginStatus = effectiveLoginStatus(user);
    const bankingStatus = user.accountStatus || '';
    const loginNeedsHelp = loginStatus === 'blocked' || loginStatus === 'deactivated';
    const bankingNeedsHelp =
      bankingStatus === 'blocked' ||
      bankingStatus === 'suspended' ||
      bankingStatus === 'deactivated';

    if (!loginNeedsHelp && !bankingNeedsHelp) {
      return res.status(400).json({
        message:
          'Contact administrator is only for blocked or deactivated sign-in access, or blocked, suspended, or deactivated banking access. If you need a login unlock, use Sign in → unlock request instead.',
        supportEmail: getSupportEmail()
      });
    }

    const existing = await ContactAdminRequest.findOne({ user: user._id, status: 'open' });
    if (existing) {
      return res.status(409).json({
        code: 'CONTACT_DUPLICATE',
        message:
          'You already have an open contact request. The team has been notified — please wait for a response instead of sending another.',
        supportEmail: getSupportEmail()
      });
    }

    await ContactAdminRequest.create({
      user: user._id,
      identifier,
      email: user.email || '',
      username: user.username || '',
      loginStatus,
      accountStatus: bankingStatus,
      role: user.role || 'customer',
      message,
      status: 'open'
    });

    const note = message ? ` Note: ${message}` : '';
    const title = 'Account restore request';
    const body = `${user.fullName} (@${user.username || user.email}) · login:${loginStatus} · banking:${bankingStatus} · ${
      user.role || 'customer'
    } asked to restore access.${note}`;
    const href = user.role === 'customer' || !user.role ? '/admin/customers' : '/admin/staff';

    await Promise.allSettled([
      notifyManagers('security', title, body, href),
      notifySuperAdmins('security', title, body, href)
    ]);

    return res.json({
      message:
        'Your request was sent to NovaBank administrators. You will hear back after they review your account. Duplicate requests are not allowed while one is open.',
      supportEmail: getSupportEmail()
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        code: 'CONTACT_DUPLICATE',
        message:
          'You already have an open contact request. The team has been notified — please wait for a response instead of sending another.',
        supportEmail: getSupportEmail()
      });
    }
    console.error('Contact admin error:', error);
    return res.status(500).json({ message: 'Unable to send contact request' });
  }
});

/**
 * Public — locked-out users cannot authenticate. Notifies Super Admins via
 * in-app alerts so they can reset the lock from Customers / Directory.
 */
router.post('/request-unlock', async (req, res) => {
  try {
    const identifier = String(req.body.identifier || req.body.email || req.body.username || '').trim();
    const message = String(req.body.message || '').trim().slice(0, 500);

    if (!identifier || identifier.length < 3) {
      return res.status(400).json({ message: 'Enter the username or email used to sign in' });
    }

    const user = await findByIdentifier(identifier);
    // Avoid account enumeration — always return a calm success shape when possible.
    if (!user) {
      return res.json({
        message:
          'If that account is locked, a Super Admin has been notified. You can also wait for the temporary lock to expire.'
      });
    }
    await hydrateUser(user);

    const lockedUntil = user.loginAttempts?.lockedUntil
      ? new Date(user.loginAttempts.lockedUntil).getTime()
      : 0;
    const isLocked = lockedUntil > Date.now() || (user.loginAttempts?.count || 0) >= 5;

    if (isLocked) {
      const note = message ? ` Note: ${message}` : '';
      await notifySuperAdmins(
        'security',
        'Sign-in unlock requested',
        `${user.fullName} (@${user.username}) asked to reset a login lock.${note}`,
        '/admin/customers'
      );
    }

    return res.json({
      message:
        'Your unlock request was sent to Super Admin. You will be able to sign in again after they reset the lock, or when the temporary pause ends.'
    });
  } catch (error) {
    console.error('Request unlock error:', error);
    return res.status(500).json({ message: 'Unable to send unlock request' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { resetToken, password, confirmPassword } = req.body;

    if (!resetToken || !password || !confirmPassword) {
      return res.status(400).json({ message: 'Reset token, password, and confirmation are required' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match' });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    let payload;
    try {
      payload = jwt.verify(resetToken, process.env.JWT_SECRET);
    } catch {
      return res.status(400).json({ message: 'Reset link expired or invalid. Please verify again.' });
    }

    if (payload.purpose !== 'password_reset') {
      return res.status(400).json({ message: 'Invalid reset token' });
    }

    const user = await User.findById(payload.sub);
    if (!user) {
      return res.status(404).json({ message: 'Account not found' });
    }

    if (effectiveLoginStatus(user) === 'blocked' || effectiveLoginStatus(user) === 'deactivated') {
      return res.status(403).json(accountLifecycleBlock(user, 'forgot'));
    }

    user.password = password;
    await user.save();

    return res.json({ message: 'Password updated. You can sign in with your new password.' });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ message: 'Unable to reset password' });
  }
});

router.get('/me', auth, async (req, res) => {
  return res.json({ user: req.user.toSafeJSON() });
});

router.patch('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'Account not found' });
    }
    await hydrateUser(user);

    if (req.body.fullName != null) {
      const fullName = String(req.body.fullName).trim();
      if (fullName.length < 2) {
        return res.status(400).json({ message: 'Full name must be at least 2 characters' });
      }
      user.fullName = fullName;
    }

    if (req.body.username != null) {
      const cleanUsername = normalizeUsername(req.body.username);
      if (!/^[a-z0-9._-]{3,32}$/.test(cleanUsername)) {
        return res.status(400).json({
          message: 'Username must be 3–32 characters (letters, numbers, dots, underscores, hyphens)'
        });
      }
      const taken = await User.findOne({ username: cleanUsername, _id: { $ne: user._id } });
      if (taken) {
        return res.status(409).json({ message: 'This username is already taken' });
      }
      user.username = cleanUsername;
    }

    if (req.body.email != null) {
      const cleanEmail = String(req.body.email).toLowerCase().trim();
      const taken = await User.findOne({ email: cleanEmail, _id: { $ne: user._id } });
      if (taken) {
        return res.status(409).json({ message: 'An account with this email already exists' });
      }
      user.email = cleanEmail;
    }

    if (!user.isSuperAdmin && (req.body.countryCode != null || req.body.phone != null)) {
      if (req.body.countryCode != null) {
        const countryCode = String(req.body.countryCode).trim();
        if (countryCode && !/^\+[1-9][0-9]{0,7}$/.test(countryCode)) {
          return res.status(400).json({ message: 'Country code must look like +1 or +44' });
        }
        user.countryCode = countryCode;
      }
      if (req.body.phone != null) {
        const phone = String(req.body.phone).replace(/[\s()-]/g, '').trim();
        if (phone && !/^[0-9]{7,15}$/.test(phone)) {
          return res.status(400).json({ message: 'Phone number must be 7–15 digits' });
        }
        user.phone = phone;
      }
    }

    if (req.body.avatar) {
      const allowed = ['mint', 'sky', 'sand', 'rose', 'slate'];
      if (req.body.avatar.style && allowed.includes(req.body.avatar.style)) {
        user.avatar = user.avatar || {};
        user.avatar.style = req.body.avatar.style;
      }
      if (req.body.avatar.initials != null) {
        user.avatar = user.avatar || {};
        user.avatar.initials = String(req.body.avatar.initials).trim().slice(0, 3).toUpperCase();
      }
      if (Object.prototype.hasOwnProperty.call(req.body.avatar, 'image')) {
        user.avatar = user.avatar || {};
        const image = req.body.avatar.image;
        if (image == null || image === '') {
          user.avatar.image = null;
        } else if (typeof image === 'string' && image.startsWith('data:image/') && image.length < 1_200_000) {
          user.avatar.image = image;
          user.avatar.presetId = null;
        } else {
          return res.status(400).json({ message: 'Profile image must be a small image data URL' });
        }
      }
      if (Object.prototype.hasOwnProperty.call(req.body.avatar, 'presetId')) {
        user.avatar = user.avatar || {};
        const presetId = req.body.avatar.presetId;
        if (presetId == null || presetId === '') {
          user.avatar.presetId = null;
        } else if (typeof presetId === 'string' && AVATAR_PRESET_RE.test(presetId)) {
          user.avatar.presetId = presetId;
          user.avatar.image = null;
        } else {
          return res.status(400).json({ message: 'Invalid avatar preset' });
        }
      }
    }

    if (req.body.settings) {
      user.settings = user.settings || {};
      ['emailAlerts', 'smsAlerts', 'hideBalance', 'compactLedger', 'marketingTips'].forEach((key) => {
        if (typeof req.body.settings[key] === 'boolean') {
          user.settings[key] = req.body.settings[key];
        }
      });
      if (THEMES.includes(req.body.settings.theme)) {
        user.settings.theme = req.body.settings.theme;
      }
      if (FONTS.includes(req.body.settings.fontScale)) {
        user.settings.fontScale = req.body.settings.fontScale;
      }
      if (COLOR_MODES.includes(req.body.settings.colorMode)) {
        user.settings.colorMode = req.body.settings.colorMode;
      }
      if (req.body.settings.currency != null) {
        const currency = String(req.body.settings.currency).trim().toUpperCase();
        if (CURRENCIES.includes(currency)) {
          user.settings.currency = currency;
        } else if (currency === '' || currency === 'NONE') {
          user.settings.currency = null;
        } else {
          return res.status(400).json({ message: `Unsupported currency. Choose one of: ${CURRENCIES.join(', ')}` });
        }
      }
    }

    await user.save();

    let message = 'Profile updated';
    const onlySettings =
      !!req.body.settings &&
      req.body.fullName == null &&
      req.body.username == null &&
      req.body.email == null &&
      req.body.countryCode == null &&
      req.body.phone == null &&
      !req.body.avatar;
    const onlyAvatar =
      !!req.body.avatar &&
      req.body.fullName == null &&
      req.body.username == null &&
      req.body.email == null &&
      req.body.countryCode == null &&
      req.body.phone == null &&
      !req.body.settings;
    if (onlySettings) {
      message = 'Preferences saved.';
    } else if (onlyAvatar) {
      message = 'Avatar updated.';
    }

    return res.json({ message, user: user.toSafeJSON() });
  } catch (error) {
    console.error('Profile update error:', error);
    return res.status(500).json({ message: 'Unable to update profile' });
  }
});

router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new password are required' });
    }
    if (confirmPassword != null && newPassword !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const user = await User.findById(req.user._id);
    if (!user || !(await user.comparePassword(currentPassword))) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    user.password = newPassword;
    await user.save();
    return res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({ message: 'Unable to change password' });
  }
});

module.exports = router;
