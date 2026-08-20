const mongoose = require('mongoose');

/** Approved daily money caps for a customer. */
const limitPolicySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true
    },
    depositDaily: { type: Number, default: 5000, min: 0 },
    withdrawDaily: { type: Number, default: 2000, min: 0 },
    transferDaily: { type: Number, default: 3000, min: 0 },
    transferCountDaily: { type: Number, default: 10, min: 1 }
  },
  { timestamps: true }
);

module.exports = mongoose.model('LimitPolicy', limitPolicySchema);
