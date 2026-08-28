const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { sealCardSecrets, revealCardSecrets } = require('../utils/card-crypto');

const THEMES = [
  'daylight',
  'midnight',
  'sand',
  'ocean',
  'graphite',
  'orchid',
  'aurora',
  'forest',
  'ember',
  'mist'
];
const FONTS = ['comfortable', 'compact', 'large', 'editorial', 'technical'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AED', 'JPY', 'CAD', 'AUD'];
const COLOR_MODES = ['light', 'dark'];

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 80
    },
    username: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 32,
      match: [/^[a-z0-9._-]+$/, 'Username may only contain letters, numbers, dots, underscores, and hyphens']
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    /** E.164-style dial code, e.g. +1 — not used for Super Admin */
    countryCode: {
      type: String,
      trim: true,
      default: '',
      maxlength: 8
    },
    /** National phone digits (no spaces) — not used for Super Admin */
    phone: {
      type: String,
      trim: true,
      default: '',
      maxlength: 20
    },
    password: {
      type: String,
      required: true,
      minlength: 6
    },
    accountNumber: {
      type: String,
      unique: true,
      sparse: true,
      default: null
    },
    role: {
      type: String,
      enum: ['customer', 'manager', 'admin'],
      default: 'customer'
    },
    /** First seeded admin only */
    isSuperAdmin: {
      type: Boolean,
      default: false
    },
    /**
     * Staff (manager/admin) must be approved by Super Admin before login.
     * Customers ignore this (always active).
     */
    staffStatus: {
      type: String,
      enum: ['active', 'pending_approval', 'rejected'],
      default: 'active'
    },
    /**
     * Portal / sign-in access. Independent of banking ledger KYC status.
     * blocked | deactivated | deleted prevent login; active allows sign-in.
     */
    loginStatus: {
      type: String,
      enum: ['active', 'blocked', 'deactivated', 'deleted'],
      default: 'active',
      index: true
    },
    /**
     * Banking / ledger / KYC status (dual-written to Account collection).
     * suspended = banking freeze while the user may still sign in.
     */
    accountStatus: {
      type: String,
      enum: [
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
      ],
      default: 'address_required'
    },
    address: {
      line1: String,
      line2: String,
      city: String,
      state: String,
      postalCode: String,
      country: String
    },
    card: {
      holderName: String,
      /** AES-GCM ciphertext (enc:v1:…) — decrypt only in toSafeJSON / authorized views */
      number: String,
      expiryMonth: String,
      expiryYear: String,
      /** AES-GCM ciphertext */
      cvv: String,
      /** HMAC of PAN for lookups */
      numberHash: { type: String, default: null },
      /** HMAC of PAN+CVV — unique sparse index closes race beyond findOne */
      comboHash: { type: String, default: null },
      brand: {
        type: String,
        enum: ['novabank', 'visa', 'mastercard', 'amex', 'discover'],
        default: 'visa'
      },
      accountType: {
        type: String,
        enum: ['savings', 'credit', 'debit', 'personal', 'business', 'other'],
        default: 'personal'
      },
      accountExpiryMonth: String,
      accountExpiryYear: String,
      status: { type: String, enum: ['pending', 'active', 'blocked', 'frozen'], default: 'pending' },
      controls: {
        frozen: { type: Boolean, default: false },
        onlinePayments: { type: Boolean, default: true },
        contactless: { type: Boolean, default: true },
        international: { type: Boolean, default: false },
        atmWithdrawals: { type: Boolean, default: true }
      }
    },
    limits: {
      depositDaily: { type: Number, default: 5000, min: 0 },
      withdrawDaily: { type: Number, default: 2000, min: 0 },
      transferDaily: { type: Number, default: 3000, min: 0 },
      transferCountDaily: { type: Number, default: 10, min: 1 }
    },
    pendingLimitRequest: {
      status: {
        type: String,
        enum: ['none', 'pending', 'approved', 'rejected'],
        default: 'none'
      },
      requestedAt: Date,
      decidedAt: Date,
      reviewNote: String,
      proposed: {
        depositDaily: Number,
        withdrawDaily: Number,
        transferDaily: Number,
        transferCountDaily: Number
      }
    },
    balance: {
      type: Number,
      default: 1000,
      min: 0
    },
    /** Failed password attempts; Super Admin can reset from Customers directory */
    loginAttempts: {
      count: { type: Number, default: 0, min: 0 },
      lockedUntil: { type: Date, default: null },
      lastFailedAt: { type: Date, default: null }
    },
    /** One-time login codes (email / phone). Cleared after successful verify. */
    loginOtp: {
      codeHash: { type: String, default: null },
      channel: { type: String, default: null },
      destination: { type: String, default: null },
      expiresAt: { type: Date, default: null },
      attempts: { type: Number, default: 0, min: 0 },
      sentAt: { type: Date, default: null }
    },
    avatar: {
      style: {
        type: String,
        enum: ['mint', 'sky', 'sand', 'rose', 'slate'],
        default: 'mint'
      },
      initials: {
        type: String,
        default: ''
      },
      image: {
        type: String,
        default: null
      },
      /** Role-scoped preset under assets/avatars/{role}/preset-NN.webp */
      presetId: {
        type: String,
        default: null,
        trim: true,
        maxlength: 64
      }
    },
    settings: {
      emailAlerts: { type: Boolean, default: true },
      smsAlerts: { type: Boolean, default: false },
      hideBalance: { type: Boolean, default: false },
      compactLedger: { type: Boolean, default: false },
      marketingTips: { type: Boolean, default: false },
      theme: {
        type: String,
        enum: THEMES,
        default: 'daylight'
      },
      fontScale: {
        type: String,
        enum: FONTS,
        default: 'comfortable'
      },
      /** light | dark — navbar toggle; independent of color theme accents */
      colorMode: {
        type: String,
        enum: COLOR_MODES,
        default: 'light'
      },
      /**
       * Transaction display currency. null/undefined = not configured yet —
       * money APIs reject until the user picks one in Account → Experience.
       */
      currency: {
        type: String,
        default: null
      }
    }
  },
  { timestamps: true }
);

userSchema.index({ 'card.comboHash': 1 }, { unique: true, sparse: true });

userSchema.pre('save', async function hashPasswordAndSealCard(next) {
  try {
    if (this.isModified('password')) {
      const salt = await bcrypt.genSalt(10);
      this.password = await bcrypt.hash(this.password, salt);
    }
    if (this.card && (this.isModified('card') || this.isNew)) {
      const sealed = sealCardSecrets(this.card.toObject ? this.card.toObject() : { ...this.card });
      this.card.number = sealed.number;
      this.card.cvv = sealed.cvv;
      this.card.numberHash = sealed.numberHash;
      this.card.comboHash = sealed.comboHash;
    }
    next();
  } catch (error) {
    next(error);
  }
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

/** Dual-write identity embeds into domain collections (accounts, cards, …). */
userSchema.post('save', async function syncDomainCollections(doc) {
  try {
    const { syncUserToDomain } = require('../services/user-domain');
    await syncUserToDomain(doc);
  } catch (err) {
    console.warn('[domain-sync]', err.message);
  }
});

userSchema.methods.toSafeJSON = function toSafeJSON() {
  const initials =
    (this.avatar && this.avatar.initials) ||
    String(this.fullName || '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase();

  return {
    id: this._id.toString(),
    fullName: this.fullName,
    username: this.username,
    email: this.email,
    countryCode: this.countryCode || '',
    phone: this.phone || '',
    accountNumber: this.accountNumber || null,
    balance: this.balance,
    role: this.role || 'customer',
    isSuperAdmin: !!this.isSuperAdmin,
    staffStatus: this.staffStatus || 'active',
    loginStatus: this.loginStatus || 'active',
    accountStatus: this.accountStatus || (this.accountNumber ? 'active' : 'address_required'),
    /** Explicit alias — same value as accountStatus (banking/ledger/KYC). */
    bankingAccountStatus: this.accountStatus || (this.accountNumber ? 'active' : 'address_required'),
    address: this.address || null,
    loginAttempts: {
      count: this.loginAttempts?.count || 0,
      lockedUntil: this.loginAttempts?.lockedUntil || null,
      remaining: Math.max(0, 5 - (this.loginAttempts?.count || 0))
    },
    card: this.card
      ? (() => {
          const revealed = revealCardSecrets(
            this.card.toObject ? this.card.toObject() : { ...this.card }
          );
          return {
            holderName: revealed.holderName,
            number: revealed.number,
            expiryMonth: revealed.expiryMonth,
            expiryYear: revealed.expiryYear,
            cvv: revealed.cvv,
            brand: revealed.brand || 'visa',
            accountType: revealed.accountType || 'personal',
            accountExpiryMonth: revealed.accountExpiryMonth || revealed.expiryMonth || null,
            accountExpiryYear: revealed.accountExpiryYear || revealed.expiryYear || null,
            status: revealed.status || 'pending',
            controls: {
              frozen: !!revealed.controls?.frozen,
              onlinePayments: revealed.controls?.onlinePayments !== false,
              contactless: revealed.controls?.contactless !== false,
              international: !!revealed.controls?.international,
              atmWithdrawals: revealed.controls?.atmWithdrawals !== false
            }
          };
        })()
      : null,
    limits: {
      depositDaily: this.limits?.depositDaily ?? 5000,
      withdrawDaily: this.limits?.withdrawDaily ?? 2000,
      transferDaily: this.limits?.transferDaily ?? 3000,
      transferCountDaily: this.limits?.transferCountDaily ?? 10
    },
    pendingLimitRequest: this.pendingLimitRequest
      ? {
          status: this.pendingLimitRequest.status || 'none',
          requestedAt: this.pendingLimitRequest.requestedAt || null,
          decidedAt: this.pendingLimitRequest.decidedAt || null,
          reviewNote: this.pendingLimitRequest.reviewNote || null,
          proposed: this.pendingLimitRequest.proposed || null
        }
      : { status: 'none' },
    avatar: {
      style: (this.avatar && this.avatar.style) || 'mint',
      initials: initials || 'NB',
      image: (this.avatar && this.avatar.image) || null,
      presetId: (this.avatar && this.avatar.presetId) || null
    },
    settings: {
      emailAlerts: this.settings?.emailAlerts !== false,
      smsAlerts: !!this.settings?.smsAlerts,
      hideBalance: !!this.settings?.hideBalance,
      compactLedger: !!this.settings?.compactLedger,
      marketingTips: !!this.settings?.marketingTips,
      theme: this.settings?.theme || 'daylight',
      fontScale: this.settings?.fontScale || 'comfortable',
      colorMode: this.settings?.colorMode === 'dark' ? 'dark' : 'light',
      currency: this.settings?.currency || null
    },
    createdAt: this.createdAt
  };
};

module.exports = mongoose.model('User', userSchema);
module.exports.THEMES = THEMES;
module.exports.FONTS = FONTS;
module.exports.CURRENCIES = CURRENCIES;
module.exports.COLOR_MODES = COLOR_MODES;
