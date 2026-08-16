const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

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
    accountStatus: {
      type: String,
      enum: ['pending', 'address_required', 'under_review', 'approved', 'active', 'rejected', 'blocked', 'deactivated'],
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
      brand: { type: String, default: 'novabank' },
      status: { type: String, enum: ['pending', 'active', 'blocked'], default: 'pending' }
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
      marketingTips: { type: Boolean, default: false }
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
    accountStatus: this.accountStatus || (this.accountNumber ? 'active' : 'address_required'),
    address: this.address || null,
    card: this.card
      ? {
          holderName: this.card.holderName,
          number: this.card.number,
          expiryMonth: this.card.expiryMonth,
          expiryYear: this.card.expiryYear,
          cvv: this.card.cvv,
          brand: this.card.brand || 'novabank',
          status: this.card.status || 'pending'
        }
      : null,
    avatar: {
      style: (this.avatar && this.avatar.style) || 'mint',
      initials: initials || 'NB',
      image: (this.avatar && this.avatar.image) || null
    },
    settings: {
      emailAlerts: this.settings?.emailAlerts !== false,
      hideBalance: !!this.settings?.hideBalance,
      compactLedger: !!this.settings?.compactLedger,
      marketingTips: !!this.settings?.marketingTips
    },
    createdAt: this.createdAt
  };
};

module.exports = mongoose.model('User', userSchema);
