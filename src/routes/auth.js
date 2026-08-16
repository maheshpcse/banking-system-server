const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { generateAccountNumber } = require('../utils/helpers');
const auth = require('../middleware/auth');

const router = express.Router();

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
    const existingEmail = await User.findOne({ email: cleanEmail });
    if (existingEmail) {
      return res.status(409).json({ message: 'An account with this email already exists' });
    }

    const existingUsername = await User.findOne({ username: cleanUsername });
    if (existingUsername) {
      return res.status(409).json({ message: 'This username is already taken' });
    }

    const user = await User.create({
      fullName: String(fullName).trim(),
      username: cleanUsername,
      email: cleanEmail,
      password,
      accountNumber: null,
      accountStatus: 'address_required',
      role: 'customer',
      balance: 0,
      avatar: {
        style: 'mint',
        initials: String(fullName)
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => part[0])
          .join('')
          .toUpperCase()
      }
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

router.post('/login', async (req, res) => {
  try {
    const identifier = req.body.identifier || req.body.email || req.body.username;
    const { password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ message: 'Username/email and password are required' });
    }

    const user = await findByIdentifier(identifier);
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid username/email or password' });
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
        } else {
          return res.status(400).json({ message: 'Profile image must be a small image data URL' });
        }
      }
    }

    if (req.body.settings) {
      user.settings = user.settings || {};
      ['emailAlerts', 'hideBalance', 'compactLedger', 'marketingTips'].forEach((key) => {
        if (typeof req.body.settings[key] === 'boolean') {
          user.settings[key] = req.body.settings[key];
        }
      });
    }

    await user.save();
    return res.json({ message: 'Profile updated', user: user.toSafeJSON() });
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
