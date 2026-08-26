const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { hydrateUser } = require('../services/user-domain');

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

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user) {
      return res.status(401).json({ message: 'Invalid session' });
    }
    await hydrateUser(user);

    const loginStatus = effectiveLoginStatus(user);
    if (loginStatus === 'blocked' || loginStatus === 'deactivated' || loginStatus === 'deleted') {
      const support = String(
        process.env.SUPPORT_EMAIL || process.env.ADMIN_EMAIL || 'support@novabank.local'
      )
        .trim()
        .toLowerCase();
      const code =
        loginStatus === 'blocked'
          ? 'ACCOUNT_BLOCKED'
          : loginStatus === 'deactivated'
            ? 'ACCOUNT_DEACTIVATED'
            : 'ACCOUNT_DELETED';
      const message =
        loginStatus === 'deleted'
          ? 'This account was deleted by staff. You can no longer use this session.'
          : `Your account is ${loginStatus}. You cannot use the portal until staff restore access. Contact ${support} or use Contact administrator.`;
      return res.status(403).json({ code, message, supportEmail: support });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

module.exports = authMiddleware;
