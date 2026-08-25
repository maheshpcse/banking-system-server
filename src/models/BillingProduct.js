const mongoose = require('mongoose');

const billingProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    sku: { type: String, trim: true, maxlength: 40, default: '' },
    price: { type: Number, required: true, min: 0 },
    stock: { type: Number, required: true, min: 0, default: 0 },
    gstPercentage: { type: Number, required: true, min: 0, max: 100, default: 18 },
    active: { type: Boolean, default: true },
    ratingSum: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

billingProductSchema.methods.toSafeJSON = function toSafeJSON() {
  const ratingCount = Number(this.ratingCount) || 0;
  const ratingSum = Number(this.ratingSum) || 0;
  return {
    id: this._id.toString(),
    name: this.name,
    sku: this.sku || '',
    price: this.price,
    stock: this.stock,
    gstPercentage: this.gstPercentage,
    active: !!this.active,
    ratingCount,
    ratingAvg: ratingCount ? Math.round((ratingSum / ratingCount) * 10) / 10 : 0,
    createdAt: this.createdAt?.toISOString?.() || this.createdAt
  };
};

module.exports = mongoose.model('BillingProduct', billingProductSchema);
