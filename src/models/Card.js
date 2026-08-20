const mongoose = require('mongoose');
const { sealCardSecrets } = require('../utils/card-crypto');

const cardSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true
    },
    holderName: String,
    /** AES-GCM ciphertext */
    number: String,
    expiryMonth: String,
    expiryYear: String,
    /** AES-GCM ciphertext */
    cvv: String,
    numberHash: { type: String, default: null },
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
  { timestamps: true }
);

cardSchema.index({ comboHash: 1 }, { unique: true, sparse: true });

cardSchema.pre('save', function sealCard(next) {
  try {
    const sealed = sealCardSecrets(this.toObject());
    this.number = sealed.number;
    this.cvv = sealed.cvv;
    this.numberHash = sealed.numberHash;
    this.comboHash = sealed.comboHash;
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model('Card', cardSchema);
