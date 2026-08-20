const mongoose = require('mongoose');

/** Customer account-opening applications (KYC / card issue workflow). */
const accountApplicationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: ['under_review', 'approved', 'rejected'],
      default: 'under_review',
      index: true
    },
    submittedAt: { type: Date, default: Date.now },
    decidedAt: Date,
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    reviewNote: String,
    /** Snapshot at submit time for audit / review UI */
    addressSnapshot: {
      line1: String,
      line2: String,
      city: String,
      state: String,
      postalCode: String,
      country: String
    },
    cardSnapshot: {
      holderName: String,
      brand: String,
      accountType: String,
      expiryMonth: String,
      expiryYear: String
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('AccountApplication', accountApplicationSchema);
