const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const THEMES = ['daylight', 'midnight', 'sand', 'ocean', 'graphite', 'orchid'];
const FONTS = ['comfortable', 'compact', 'large', 'editorial', 'technical'];

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
        'deactivated'
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
      number: String,
      expiryMonth: String,
      expiryYear: String,
      cvv: String,
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
      }
    },
    settings: {
      emailAlerts: { type: Boolean, default: true },
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
      }
    }
  },
  { timestamps: true }
);

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

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
    accountNumber: this.accountNumber || null,
    balance: this.balance,
    role: this.role || 'customer',
    isSuperAdmin: !!this.isSuperAdmin,
    staffStatus: this.staffStatus || 'active',
    accountStatus: this.accountStatus || (this.accountNumber ? 'active' : 'address_required'),
    address: this.address || null,
    card: this.card
      ? {
          holderName: this.card.holderName,
          number: this.card.number,
          expiryMonth: this.card.expiryMonth,
          expiryYear: this.card.expiryYear,
          cvv: this.card.cvv,
          brand: this.card.brand || 'visa',
          accountType: this.card.accountType || 'personal',
          accountExpiryMonth: this.card.accountExpiryMonth || this.card.expiryMonth || null,
          accountExpiryYear: this.card.accountExpiryYear || this.card.expiryYear || null,
          status: this.card.status || 'pending',
          controls: {
            frozen: !!this.card.controls?.frozen,
            onlinePayments: this.card.controls?.onlinePayments !== false,
            contactless: this.card.controls?.contactless !== false,
            international: !!this.card.controls?.international,
            atmWithdrawals: this.card.controls?.atmWithdrawals !== false
          }
        }
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
      image: (this.avatar && this.avatar.image) || null
    },
    settings: {
      emailAlerts: this.settings?.emailAlerts !== false,
      hideBalance: !!this.settings?.hideBalance,
      compactLedger: !!this.settings?.compactLedger,
      marketingTips: !!this.settings?.marketingTips,
      theme: this.settings?.theme || 'daylight',
      fontScale: this.settings?.fontScale || 'comfortable'
    },
    createdAt: this.createdAt
  };
};

module.exports = mongoose.model('User', userSchema);
module.exports.THEMES = THEMES;
module.exports.FONTS = FONTS;
