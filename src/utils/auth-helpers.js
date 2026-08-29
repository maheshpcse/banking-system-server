const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const CONSOLE_LOGIN_PATH = '/auth/console/login';

function getSupportEmail() {
  return String(process.env.SUPPORT_EMAIL || process.env.ADMIN_EMAIL || 'support@novabank.local')
    .trim()
    .toLowerCase();
}

function withSupport(payload) {
  return { ...payload, supportEmail: getSupportEmail() };
}

function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function signResetToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), purpose: 'password_reset' },
    process.env.JWT_SECRET,
    { expiresIn: '20m' }
  );
}

function normalizeUsername(value) {
  return String(value || '')
    .toLowerCase()
    .trim();
}

function looksLikeEmail(value) {
  return String(value || '').includes('@');
}

async function findByIdentifier(identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) {
    return null;
  }
  if (looksLikeEmail(raw)) {
    return User.findOne({ email: raw.toLowerCase() });
  }
  return User.findOne({ username: normalizeUsername(raw) });
}

async function findUserForOtp(channel, identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) {
    return null;
  }
  if (channel === 'email') {
    if (looksLikeEmail(raw)) {
      return User.findOne({ email: raw.toLowerCase() });
    }
    return User.findOne({
      $or: [{ email: raw.toLowerCase() }, { username: normalizeUsername(raw) }]
    });
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) {
    return null;
  }
  return User.findOne({
    $or: [{ phone: digits }, { phone: raw }, { username: normalizeUsername(raw) }]
  });
}

function maskDestination(channel, value) {
  const raw = String(value || '');
  if (channel === 'email') {
    const [user, domain] = raw.split('@');
    if (!domain) {
      return '***';
    }
    const keep = Math.min(2, user.length);
    return `${user.slice(0, keep)}***@${domain}`;
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 4) {
    return '***';
  }
  return `***${digits.slice(-4)}`;
}

function hashOtp(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function effectiveLoginStatus(user) {
  if (user?.loginStatus != null && String(user.loginStatus).trim() !== '') {
    return String(user.loginStatus).trim();
  }
  const banking = String(user?.accountStatus || '').trim();
  if (banking === 'blocked' || banking === 'deactivated' || banking === 'deleted') {
    return banking;
  }
  return 'active';
}

function accountLifecycleBlock(user, context = 'login') {
  const status = effectiveLoginStatus(user);
  const support = getSupportEmail();
  if (status === 'blocked') {
    if (context === 'forgot') {
      return withSupport({
        code: 'ACCOUNT_BLOCKED',
        message: `This account is blocked, so password reset is not available. Contact ${support} or use Contact administrator to restore access. You may register a new account only with a different username and a different email.`
      });
    }
    if (context === 'signup') {
      return withSupport({
        code: 'ACCOUNT_BLOCKED',
        message: `This username or email belongs to a blocked account. You cannot sign up with the same username or email until staff restore access. Use a different username and a different email for a new account, or contact ${support} / Contact administrator.`
      });
    }
    return withSupport({
      code: 'ACCOUNT_BLOCKED',
      message: `Your account is blocked. You cannot sign in until staff restore access. Contact ${support} or use Contact administrator.`
    });
  }
  if (status === 'deactivated') {
    if (context === 'forgot') {
      return withSupport({
        code: 'ACCOUNT_DEACTIVATED',
        message: `This account is deactivated, so password reset is not available. Contact ${support} or use Contact administrator to reactivate access. You may register a new account only with a different username and a different email.`
      });
    }
    if (context === 'signup') {
      return withSupport({
        code: 'ACCOUNT_DEACTIVATED',
        message: `This username or email belongs to a deactivated account. You cannot sign up with the same username or email until staff reactivate access. Use a different username and a different email for a new account, or contact ${support} / Contact administrator.`
      });
    }
    return withSupport({
      code: 'ACCOUNT_DEACTIVATED',
      message: `Your account is deactivated. You cannot sign in until staff reactivate access. Contact ${support} or use Contact administrator.`
    });
  }
  if (status === 'deleted') {
    return withSupport({
      code: 'ACCOUNT_DELETED',
      message:
        'This account was deleted by staff. You can no longer sign in. Please create a new account (you may reuse the same email or username).'
    });
  }
  return null;
}

function staffAccessBlock(user) {
  const role = user.role || 'customer';
  if ((role === 'manager' || role === 'admin') && !user.isSuperAdmin) {
    if ((user.staffStatus || 'active') === 'pending_approval') {
      return {
        code: 'STAFF_PENDING',
        message:
          'Your staff access is awaiting Super Admin verification. Activation usually completes within 24 hours.'
      };
    }
    if (user.staffStatus === 'rejected') {
      return {
        code: 'STAFF_REJECTED',
        message: 'This staff registration was not approved. Contact NovaBank Super Admin for next steps.'
      };
    }
  }
  return null;
}

/** Banking portal rejects Super Admin — they must use Console login. */
function superAdminUseConsoleBlock(action = 'sign in') {
  return {
    code: 'USE_CONSOLE_LOGIN',
    message: `Super Admin accounts cannot ${action} through the Banking or Billing portal. Use the Apex Console at ${CONSOLE_LOGIN_PATH}.`
  };
}

/** Console portal rejects non–Super Admin — they must use banking login. */
function nonSuperAdminUseBankingBlock(action = 'sign in') {
  return {
    code: 'USE_BANKING_LOGIN',
    message: `Only Super Admin can ${action} through the Apex Console. Customers, managers, and admins must use the Banking login at /auth/login.`
  };
}

function clearLoginOtp(user) {
  user.loginOtp = {
    codeHash: null,
    channel: null,
    destination: null,
    expiresAt: null,
    attempts: 0,
    sentAt: null
  };
}

module.exports = {
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  CONSOLE_LOGIN_PATH,
  getSupportEmail,
  withSupport,
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
  nonSuperAdminUseBankingBlock,
  clearLoginOtp
};
