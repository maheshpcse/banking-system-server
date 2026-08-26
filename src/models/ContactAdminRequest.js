const mongoose = require('mongoose');

const contactAdminRequestSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    identifier: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true, default: '' },
    username: { type: String, trim: true, lowercase: true, default: '' },
    /** Portal / sign-in status snapshot at request time */
    loginStatus: { type: String, trim: true, default: '' },
    /** Banking / ledger status snapshot at request time */
    accountStatus: { type: String, trim: true, default: '' },
    role: { type: String, trim: true, default: 'customer' },
    message: { type: String, trim: true, maxlength: 600, default: '' },
    status: {
      type: String,
      enum: ['open', 'resolved'],
      default: 'open',
      index: true
    }
  },
  { timestamps: true }
);

contactAdminRequestSchema.index(
  { user: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } }
);

module.exports = mongoose.model('ContactAdminRequest', contactAdminRequestSchema);
