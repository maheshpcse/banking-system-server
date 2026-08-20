const mongoose = require('mongoose');

/** Per-user sign-in lockout / attempt counters. */
const loginSecuritySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true
    },
    count: { type: Number, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
    lastFailedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('LoginSecurity', loginSecuritySchema);
