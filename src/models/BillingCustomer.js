const mongoose = require('mongoose');

const billingCustomerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, maxlength: 160, default: '' },
    phone: { type: String, trim: true, maxlength: 32, default: '' },
    address: { type: String, trim: true, maxlength: 240, default: '' },
    /** Optional link into NovaBank ledger identity */
    bankingAccountNumber: { type: String, trim: true, maxlength: 32, default: null },
    bankingUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

billingCustomerSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    email: this.email || '',
    phone: this.phone || '',
    address: this.address || '',
    bankingAccountNumber: this.bankingAccountNumber || null,
    createdAt: this.createdAt?.toISOString?.() || this.createdAt
  };
};

module.exports = mongoose.model('BillingCustomer', billingCustomerSchema);
