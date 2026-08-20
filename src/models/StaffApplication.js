const mongoose = require('mongoose');

/** Manager / admin self-signup requests awaiting Super Admin decision. */
const staffApplicationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true
    },
    role: {
      type: String,
      enum: ['manager', 'admin'],
      required: true
    },
    status: {
      type: String,
      enum: ['pending_approval', 'active', 'rejected'],
      default: 'pending_approval',
      index: true
    },
    fullName: String,
    username: String,
    email: String,
    submittedAt: { type: Date, default: Date.now },
    decidedAt: Date,
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    reviewNote: String
  },
  { timestamps: true }
);

module.exports = mongoose.model('StaffApplication', staffApplicationSchema);
