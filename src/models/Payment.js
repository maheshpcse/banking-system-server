const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    bill: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', required: true, index: true },
    billNumber: { type: String, required: true },
    paymentMethod: {
      type: String,
      enum: ['cash', 'card', 'upi', 'qr'],
      required: true
    },
    status: {
      type: String,
      enum: ['pending', 'success', 'failed'],
      default: 'pending'
    },
    amount: { type: Number, required: true, min: 0 },
    transactionRef: { type: String, required: true, unique: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

paymentSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    billId: this.bill?.toString?.() || String(this.bill),
    billNumber: this.billNumber,
    paymentMethod: this.paymentMethod,
    status: this.status,
    amount: this.amount,
    transactionRef: this.transactionRef,
    meta: this.meta || {},
    createdAt: this.createdAt?.toISOString?.() || this.createdAt
  };
};

module.exports = mongoose.model('Payment', paymentSchema);
