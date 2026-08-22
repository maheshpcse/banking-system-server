const mongoose = require('mongoose');

const billingSettingsSchema = new mongoose.Schema(
  {
    merchantName: { type: String, trim: true, default: 'NovaBill POS' },
    supportNote: { type: String, trim: true, maxlength: 240, default: 'Demo gateway — no real charges.' },
    methods: {
      cash: { type: Boolean, default: true },
      card: { type: Boolean, default: true },
      upi: { type: Boolean, default: true },
      qr: { type: Boolean, default: true }
    },
    upiVpa: { type: String, trim: true, default: 'novabill@demo' },
    cardLabel: { type: String, trim: true, default: 'Demo Card Rail' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

billingSettingsSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    merchantName: this.merchantName,
    supportNote: this.supportNote,
    methods: {
      cash: !!this.methods?.cash,
      card: !!this.methods?.card,
      upi: !!this.methods?.upi,
      qr: !!this.methods?.qr
    },
    upiVpa: this.upiVpa || '',
    cardLabel: this.cardLabel || '',
    updatedAt: this.updatedAt?.toISOString?.() || this.updatedAt
  };
};

module.exports = mongoose.model('BillingSettings', billingSettingsSchema);
