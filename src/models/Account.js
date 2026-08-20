const mongoose = require('mongoose');

/**
 * Banking account ledger row — one per customer user.
 * Balance and accountNumber live here (not on the slim User identity doc).
 */
const accountSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true
    },
    accountNumber: {
      type: String,
      unique: true,
      sparse: true,
      default: null
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
      default: 'address_required',
      index: true
    },
    balance: {
      type: Number,
      default: 0,
      min: 0
    },
    currency: {
      type: String,
      default: null
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Account', accountSchema);
