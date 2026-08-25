/**
 * Multi-channel notifications: in-app (always) + email/SMS when enabled.
 * Email/SMS no-op gracefully when EMAIL_ENABLED / SMS_ENABLED are not "true"
 * or provider credentials are missing.
 */
const Notification = require('../models/Notification');
const User = require('../models/User');

function emailConfigured() {
  return (
    process.env.EMAIL_ENABLED === 'true' &&
    !!(process.env.RESEND_API_KEY || process.env.SMTP_URL || process.env.EMAIL_WEBHOOK_URL)
  );
}

function smsConfigured() {
  return (
    process.env.SMS_ENABLED === 'true' &&
    !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM)
  );
}

function formatPhone(user) {
  const code = String(user.countryCode || '').trim();
  const phone = String(user.phone || '').replace(/[\s()-]/g, '').trim();
  if (!code || !phone) {
    return null;
  }
  return `${code}${phone}`;
}

async function sendEmail({ to, subject, text }) {
  if (!emailConfigured()) {
    if (process.env.NOTIFY_DEBUG === 'true') {
      console.info('[email:noop]', { to, subject, text });
    }
    return { skipped: true, reason: 'email_disabled' };
  }

  const from = process.env.EMAIL_FROM || 'NovaBank <noreply@novabank.local>';

  try {
    if (process.env.RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from, to: [to], subject, text })
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Resend ${res.status}: ${detail}`);
      }
      return { sent: true, provider: 'resend' };
    }

    if (process.env.EMAIL_WEBHOOK_URL) {
      const res = await fetch(process.env.EMAIL_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject, text })
      });
      if (!res.ok) {
        throw new Error(`Email webhook ${res.status}`);
      }
      return { sent: true, provider: 'webhook' };
    }

    // SMTP_URL present but no nodemailer dependency — log for operators.
    console.info('[email:smtp-configured-without-sdk]', { to, subject });
    return { skipped: true, reason: 'smtp_sdk_missing' };
  } catch (error) {
    console.warn('[email:failed]', error.message);
    return { skipped: true, reason: error.message };
  }
}

async function sendSms({ to, body }) {
  if (!smsConfigured()) {
    if (process.env.NOTIFY_DEBUG === 'true') {
      console.info('[sms:noop]', { to, body });
    }
    return { skipped: true, reason: 'sms_disabled' };
  }

  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const params = new URLSearchParams({ To: to, From: from, Body: body });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Twilio ${res.status}: ${detail}`);
    }
    return { sent: true, provider: 'twilio' };
  } catch (error) {
    console.warn('[sms:failed]', error.message);
    return { skipped: true, reason: error.message };
  }
}

async function createInApp({ userId, kind, title, body, href }) {
  return Notification.create({
    user: userId,
    kind: kind || 'system',
    title,
    body,
    href: href || null,
    read: false
  });
}

/**
 * @param {object|string} userOrId - User doc or id
 * @param {object} opts
 * @param {string} opts.kind
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} [opts.href]
 * @param {boolean} [opts.forceEmail] - send email even if emailAlerts is off (security/ops)
 * @param {boolean} [opts.forceSms] - send SMS even if smsAlerts is off
 * @param {boolean} [opts.skipInApp]
 */
async function notifyUser(userOrId, opts) {
  const {
    kind,
    title,
    body,
    href,
    forceEmail = false,
    forceSms = false,
    skipInApp = false
  } = opts || {};

  let user = userOrId;
  if (!user || !user.email) {
    user = await User.findById(userOrId?._id || userOrId).select(
      'email fullName countryCode phone settings isSuperAdmin role'
    );
  }
  if (!user) {
    return null;
  }

  let doc = null;
  if (!skipInApp) {
    try {
      doc = await createInApp({
        userId: user._id,
        kind,
        title,
        body,
        href
      });
    } catch (error) {
      console.warn('In-app notification failed:', error.message);
    }
  }

  const wantsEmail = forceEmail || user.settings?.emailAlerts !== false;
  const wantsSms = forceSms || !!user.settings?.smsAlerts;

  const channels = [];
  if (wantsEmail && user.email) {
    channels.push(
      sendEmail({
        to: user.email,
        subject: `[NovaBank] ${title}`,
        text: `${body}\n\n— NovaBank`
      })
    );
  }

  const e164 = formatPhone(user);
  if (wantsSms && e164) {
    channels.push(sendSms({ to: e164, body: `NovaBank: ${title} — ${body}` }));
  }

  if (channels.length) {
    await Promise.allSettled(channels);
  }

  return doc;
}

/**
 * Lifecycle/ops notify for a User: email only when email is set, SMS only when
 * countryCode+phone are set. Uses forceEmail/forceSms when those contacts exist
 * so preference toggles do not suppress staff-driven account messages.
 */
async function notifyAccountContact(userOrId, opts) {
  let user = userOrId;
  if (!user || typeof user !== 'object' || !('email' in user)) {
    user = await User.findById(userOrId?._id || userOrId).select(
      'email fullName countryCode phone settings isSuperAdmin role'
    );
  }
  if (!user) {
    return null;
  }

  const hasEmail = !!String(user.email || '').trim();
  const hasPhone = !!(
    String(user.countryCode || '').trim() && String(user.phone || '').replace(/[\s()-]/g, '').trim()
  );

  return notifyUser(user, {
    ...opts,
    forceEmail: hasEmail,
    forceSms: hasPhone
  });
}

async function notifyUsers(query, opts) {
  const users = await User.find(query).select('email fullName countryCode phone settings isSuperAdmin role');
  await Promise.allSettled(users.map((u) => notifyUser(u, opts)));
  return users.length;
}

async function notifyManagers(kind, title, body, href, channelOpts = {}) {
  try {
    await notifyUsers(
      { role: 'manager', staffStatus: 'active', isSuperAdmin: { $ne: true } },
      { kind, title, body, href, ...channelOpts }
    );
  } catch (error) {
    console.warn('Manager notify failed:', error.message);
  }
}

async function notifySuperAdmins(kind, title, body, href, channelOpts = {}) {
  try {
    // Ops alerts: always attempt email when configured (forceEmail).
    await notifyUsers(
      { isSuperAdmin: true, staffStatus: 'active' },
      { kind, title, body, href, forceEmail: true, ...channelOpts }
    );
  } catch (error) {
    console.warn('Super Admin notify failed:', error.message);
  }
}

/**
 * Notify a billing contact (customer email/phone) without requiring a User account.
 */
async function notifyBillingContact({ email, phone, title, body, brand = 'NovaBill' }) {
  const channels = [];
  const emailTo = email ? String(email).trim() : '';
  const phoneRaw = phone ? String(phone).trim() : '';

  if (emailTo) {
    channels.push(
      sendEmail({
        to: emailTo,
        subject: `[${brand}] ${title}`,
        text: `${body}\n\n— ${brand}`
      })
    );
  }

  if (phoneRaw) {
    const to = phoneRaw.startsWith('+') ? phoneRaw : phoneRaw;
    channels.push(sendSms({ to, body: `${brand}: ${title} — ${body}` }));
  }

  if (channels.length) {
    await Promise.allSettled(channels);
  }

  return { emailed: !!emailTo, sms: !!phoneRaw };
}

module.exports = {
  createInApp,
  notifyUser,
  notifyAccountContact,
  notifyBillingContact,
  /** @deprecated alias — prefer notifyBillingContact */
  notifyContact: notifyBillingContact,
  notifyUsers,
  notifyManagers,
  notifySuperAdmins,
  sendEmail,
  sendSms,
  emailConfigured,
  smsConfigured,
  formatPhone
};
