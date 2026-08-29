const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { hydrateUser } = require('../services/user-domain');
const { sendEmail } = require('../services/notify-channels');
const {
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  signToken,
  signResetToken,
  looksLikeEmail,
  findByIdentifier,
  findUserForOtp,
  maskDestination,
  hashOtp,
  effectiveLoginStatus,
  accountLifecycleBlock,
  nonSuperAdminUseBankingBlock,
  clearLoginOtp
} = require('../utils/auth-helpers');

const router = express.Router();

/**
 * Console auth — Super Admin only.
 * Mounted at /api/auth/console
 */

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

    /* Portal gate before password — Console is Super Admin only. */
    if (!user.isSuperAdmin) {
      return res.status(403).json(nonSuperAdminUseBankingBlock('sign in'));
    }

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

    const token = signToken(user);
    return res.json({
      message: 'Login successful',
      token,
      user: user.toSafeJSON()
    });
  } catch (error) {
    console.error('Console login error:', error);
    return res.status(500).json({ message: 'Unable to login' });
  }
});

router.post('/otp/request', async (req, res) => {
  try {
    const channel = String(req.body?.channel || 'email').trim().toLowerCase();
    const identifier = String(req.body?.identifier || '').trim();

    if (channel !== 'email') {
      return res.status(400).json({
        code: 'OTP_CHANNEL_INVALID',
        message: 'Console OTP sign-in supports email only.'
      });
    }
    if (!identifier || identifier.length < 3) {
      return res.status(400).json({
        code: 'OTP_IDENTIFIER_REQUIRED',
        message: 'Enter your username or email.'
      });
    }

    const user = await findUserForOtp('email', identifier);
    if (!user) {
      return res.status(404).json({
        code: 'OTP_USER_NOT_FOUND',
        message: 'No account matches that username or email.'
      });
    }
    await hydrateUser(user);

    if (!user.isSuperAdmin) {
      return res.status(403).json(nonSuperAdminUseBankingBlock('request an OTP'));
    }

    const lifecycle = accountLifecycleBlock(user);
    if (lifecycle) {
      return res.status(403).json(lifecycle);
    }

    const destination = String(user.email || '').trim().toLowerCase();
    if (!destination || !looksLikeEmail(destination)) {
      return res.status(400).json({
        code: 'OTP_CHANNEL_UNAVAILABLE',
        message: 'This account has no email on file for OTP sign-in.'
      });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    user.loginOtp = {
      codeHash: hashOtp(code),
      channel: 'email',
      destination,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      attempts: 0,
      sentAt: new Date()
    };
    await user.save();

    const brand = 'NovaBank Console';
    const body = `${brand} sign-in code: ${code}. It expires in 10 minutes.`;
    let delivered = false;
    try {
      const deliveryResult = await sendEmail({
        to: destination,
        subject: `${brand} sign-in code`,
        text: body
      });
      delivered = !!(deliveryResult && deliveryResult.sent && !deliveryResult.skipped);
    } catch (notifyError) {
      console.warn('Console OTP delivery fallback (logged only):', notifyError?.message || notifyError);
    }
    if (!delivered) {
      console.info(`[otp:console] email → ${destination}: ${code}`);
    }

    return res.json({
      message: 'OTP sent and will expire in 10 minutes.',
      expiresInMinutes: 10,
      channel: 'email',
      maskedDestination: maskDestination('email', destination),
      delivered
    });
  } catch (error) {
    console.error('Console OTP request error:', error);
    return res.status(500).json({ message: 'Unable to send OTP' });
  }
});

router.post('/otp/verify', async (req, res) => {
  try {
    const channel = String(req.body?.channel || 'email').trim().toLowerCase();
    const identifier = String(req.body?.identifier || '').trim();
    const code = String(req.body?.code || '').trim();

    if (channel !== 'email') {
      return res.status(400).json({
        code: 'OTP_CHANNEL_INVALID',
        message: 'Console OTP sign-in supports email only.'
      });
    }
    if (!identifier || !code) {
      return res.status(400).json({
        code: 'OTP_REQUIRED',
        message: 'Enter the OTP code you received.'
      });
    }

    const user = await findUserForOtp('email', identifier);
    if (!user?.loginOtp?.codeHash) {
      return res.status(400).json({
        code: 'OTP_NOT_FOUND',
        message: 'No active OTP found. Request a new code.'
      });
    }
    await hydrateUser(user);

    if (!user.isSuperAdmin) {
      return res.status(403).json(nonSuperAdminUseBankingBlock('verify an OTP'));
    }

    if (String(user.loginOtp.channel || '') !== 'email') {
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
    console.error('Console OTP verify error:', error);
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

    if (!user.isSuperAdmin) {
      return res.status(403).json(nonSuperAdminUseBankingBlock('reset a password'));
    }

    const loginStatus = effectiveLoginStatus(user);
    if (loginStatus === 'blocked' || loginStatus === 'deactivated') {
      return res.status(403).json(accountLifecycleBlock(user, 'forgot'));
    }

    const resetToken = signResetToken(user);
    return res.json({
      message: 'Identity verified. You can set a new password.',
      resetToken,
      maskedEmail: user.email.replace(/(.{2}).+(@.+)/, '$1***$2'),
      username: user.username
    });
  } catch (error) {
    console.error('Console forgot password error:', error);
    return res.status(500).json({ message: 'Unable to verify account' });
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

    if (!user.isSuperAdmin) {
      return res.status(403).json(nonSuperAdminUseBankingBlock('reset a password'));
    }

    if (effectiveLoginStatus(user) === 'blocked' || effectiveLoginStatus(user) === 'deactivated') {
      return res.status(403).json(accountLifecycleBlock(user, 'forgot'));
    }

    user.password = password;
    await user.save();

    return res.json({ message: 'Password updated. You can sign in with your new password.' });
  } catch (error) {
    console.error('Console reset password error:', error);
    return res.status(500).json({ message: 'Unable to reset password' });
  }
});

module.exports = router;
