const mongoose = require('mongoose');

const billingComplaintSchema = new mongoose.Schema(
  {
    bill: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', default: null },
    billNumber: { type: String, trim: true, default: '' },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'BillingCustomer', default: null },
    customerName: { type: String, required: true, trim: true },
    bankingAccountNumber: { type: String, trim: true, default: null },
    subject: { type: String, required: true, trim: true, maxlength: 160 },
    detail: { type: String, required: true, trim: true, maxlength: 1200 },
    status: {
      type: String,
      enum: ['open', 'accepted', 'adjusted', 'rejected', 'escalated', 'resolved'],
      default: 'open',
      index: true
    },
    resolutionNote: { type: String, trim: true, maxlength: 600, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

billingComplaintSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    billId: this.bill ? this.bill.toString() : null,
    billNumber: this.billNumber || '',
    customerId: this.customer ? this.customer.toString() : null,
    customerName: this.customerName,
    bankingAccountNumber: this.bankingAccountNumber || null,
    subject: this.subject,
    detail: this.detail,
    status: this.status,
    resolutionNote: this.resolutionNote || '',
    createdAt: this.createdAt?.toISOString?.() || this.createdAt,
    updatedAt: this.updatedAt?.toISOString?.() || this.updatedAt
  };
};

module.exports = mongoose.model('BillingComplaint', billingComplaintSchema);
