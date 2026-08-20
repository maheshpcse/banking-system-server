const mongoose = require('mongoose');

/** Pending / historical customer requests to change daily limits. */
const limitRequestSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true
    },
    requestedAt: { type: Date, default: Date.now },
    decidedAt: Date,
    reviewNote: String,
    proposed: {
      depositDaily: Number,
      withdrawDaily: Number,
      transferDaily: Number,
      transferCountDaily: Number
    },
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('LimitRequest', limitRequestSchema);
