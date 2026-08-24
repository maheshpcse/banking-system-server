const mongoose = require('mongoose');

const PAYMENT_SCOPES = ['any', 'cash', 'card', 'upi', 'qr', 'bank'];
const COUPON_KINDS = ['general', 'payment', 'bank'];
const DISCOUNT_TYPES = ['percent', 'fixed'];

const billingCouponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    kind: { type: String, enum: COUPON_KINDS, default: 'general', index: true },
    discountType: { type: String, enum: DISCOUNT_TYPES, required: true },
    value: { type: Number, required: true, min: 0 },
    /** Which checkout rails this coupon may be used with. */
    paymentScopes: {
      type: [{ type: String, enum: PAYMENT_SCOPES }],
      default: ['any']
    },
    /** Short operator-facing note shown at POS when selecting / applying. */
    usageNote: { type: String, required: true, trim: true, maxlength: 220 },
    /** Extra note for NovaBank-linked / bank coupons. */
    bankNote: { type: String, trim: true, maxlength: 220, default: '' },
    minSubtotal: { type: Number, min: 0, default: 0 },
    maxDiscount: { type: Number, min: 0, default: null },
    expiresAt: { type: Date, default: null, index: true },
    maxUses: { type: Number, min: 0, default: null },
    usedCount: { type: Number, min: 0, default: 0 },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

billingCouponSchema.methods.isExpired = function isExpired(now = new Date()) {
  if (!this.expiresAt) return false;
  return new Date(this.expiresAt).getTime() < now.getTime();
};

billingCouponSchema.methods.isExhausted = function isExhausted() {
  if (this.maxUses == null) return false;
  return Number(this.usedCount || 0) >= Number(this.maxUses);
};

billingCouponSchema.methods.allowsPaymentMethod = function allowsPaymentMethod(method) {
  const scopes = Array.isArray(this.paymentScopes) && this.paymentScopes.length
    ? this.paymentScopes
    : ['any'];
  if (scopes.includes('any')) return true;
  const m = String(method || '').toLowerCase();
  if (!m) return true;
  if (scopes.includes(m)) return true;
  // Bank coupons accept card / UPI / QR rails that settle through banking links.
  if (scopes.includes('bank') && ['card', 'upi', 'qr'].includes(m)) return true;
  return false;
};

billingCouponSchema.methods.computeDiscount = function computeDiscount(subtotal) {
  const base = Math.max(0, Number(subtotal) || 0);
  let amount = 0;
  if (this.discountType === 'percent') {
    amount = (base * Number(this.value || 0)) / 100;
  } else {
    amount = Number(this.value || 0);
  }
  amount = Math.min(amount, base);
  if (this.maxDiscount != null && this.maxDiscount >= 0) {
    amount = Math.min(amount, Number(this.maxDiscount));
  }
  return Math.round(amount * 100) / 100;
};

billingCouponSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    code: this.code,
    title: this.title,
    kind: this.kind,
    discountType: this.discountType,
    value: this.value,
    paymentScopes: this.paymentScopes || ['any'],
    usageNote: this.usageNote || '',
    bankNote: this.bankNote || '',
    minSubtotal: this.minSubtotal || 0,
    maxDiscount: this.maxDiscount,
    expiresAt: this.expiresAt ? this.expiresAt.toISOString() : null,
    maxUses: this.maxUses,
    usedCount: this.usedCount || 0,
    active: this.active !== false,
    createdAt: this.createdAt?.toISOString?.() || this.createdAt,
    updatedAt: this.updatedAt?.toISOString?.() || this.updatedAt
  };
};

module.exports = mongoose.model('BillingCoupon', billingCouponSchema);
module.exports.PAYMENT_SCOPES = PAYMENT_SCOPES;
module.exports.COUPON_KINDS = COUPON_KINDS;
module.exports.DISCOUNT_TYPES = DISCOUNT_TYPES;
