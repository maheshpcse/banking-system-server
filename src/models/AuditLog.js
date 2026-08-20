const mongoose = require('mongoose');

/** Append-only audit trail for privileged / security-sensitive actions. */
const auditLogSchema = new mongoose.Schema(
  {
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true
    },
    targetUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true
    },
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
      index: true
    },
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    ip: String,
    userAgent: String
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model('AuditLog', auditLogSchema);
