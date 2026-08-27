const mongoose = require('mongoose');

const billingCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 100, unique: true, index: true },
    description: { type: String, trim: true, maxlength: 280, default: '' },
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

billingCategorySchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    slug: this.slug || '',
    description: this.description || '',
    active: this.active !== false,
    sortOrder: Number(this.sortOrder) || 0,
    createdAt: this.createdAt?.toISOString?.() || this.createdAt,
    updatedAt: this.updatedAt?.toISOString?.() || this.updatedAt
  };
};

module.exports = mongoose.model('BillingCategory', billingCategorySchema);
