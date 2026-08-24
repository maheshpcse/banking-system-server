const mongoose = require('mongoose');

const billItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'BillingProduct', required: true },
    name: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    gstPercentage: { type: Number, required: true, min: 0, max: 100, default: 0 },
    lineTotal: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const billSchema = new mongoose.Schema(
  {
    billNumber: { type: String, required: true, unique: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'BillingCustomer', required: true },
    customerName: { type: String, required: true, trim: true },
    bankingAccountNumber: { type: String, trim: true, default: null },
    items: { type: [billItemSchema], default: [] },
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, required: true, min: 0, default: 0 },
    couponCode: { type: String, trim: true, uppercase: true, default: null },
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'BillingCoupon', default: null },
    tax: { type: Number, required: true, min: 0, default: 0 },
    grandTotal: { type: Number, required: true, min: 0 },
    paymentStatus: {
      type: String,
      enum: ['draft', 'pending', 'paid', 'failed', 'error', 'refunded'],
      default: 'pending',
      index: true
    },
    paymentMethod: {
      type: String,
      enum: ['cash', 'card', 'upi', 'qr', null],
      default: null
    },
    paidAt: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: 400, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

billSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    billNumber: this.billNumber,
    customerId: this.customer?.toString?.() || String(this.customer),
    customerName: this.customerName,
    bankingAccountNumber: this.bankingAccountNumber || null,
    items: (this.items || []).map((item) => ({
      productId: item.product?.toString?.() || String(item.product),
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      gstPercentage: item.gstPercentage,
      lineTotal: item.lineTotal
    })),
    subtotal: this.subtotal,
    discount: this.discount,
    couponCode: this.couponCode || null,
    couponId: this.couponId?.toString?.() || (this.couponId ? String(this.couponId) : null),
    tax: this.tax,
    grandTotal: this.grandTotal,
    paymentStatus: this.paymentStatus,
    paymentMethod: this.paymentMethod,
    paidAt: this.paidAt ? this.paidAt.toISOString?.() || this.paidAt : null,
    notes: this.notes || '',
    createdAt: this.createdAt?.toISOString?.() || this.createdAt,
    updatedAt: this.updatedAt?.toISOString?.() || this.updatedAt
  };
};

module.exports = mongoose.model('Bill', billSchema);
