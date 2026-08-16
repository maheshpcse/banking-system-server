const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    kind: {
      type: String,
      enum: ['transfer', 'account', 'admin', 'security', 'system'],
      default: 'system'
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 400
    },
    href: {
      type: String,
      default: null
    },
    read: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

notificationSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    kind: this.kind,
    title: this.title,
    body: this.body,
    href: this.href || undefined,
    createdAt: this.createdAt?.toISOString?.() || this.createdAt,
    read: !!this.read
  };
};

module.exports = mongoose.model('Notification', notificationSchema);
