const express = require('express');
const crypto = require('crypto');
const auth = require('../middleware/auth');
const BillingProduct = require('../models/BillingProduct');
const BillingCustomer = require('../models/BillingCustomer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const BillingComplaint = require('../models/BillingComplaint');
const BillingSettings = require('../models/BillingSettings');
const BillingCoupon = require('../models/BillingCoupon');
const BillingCategory = require('../models/BillingCategory');
const { notifyManagers, notifySuperAdmins, notifyContact } = require('../services/notify-channels');

const router = express.Router();
router.use(auth);

/** Super Admin monitors in Banking only — not a Billing POS operator. */
function isBillingOperator(user) {
  if (!user || user.isSuperAdmin) {
    return false;
  }
  return user.role === 'manager' || user.role === 'admin';
}

function requireBillingViewer(req, res, next) {
  if (req.user?.role === 'manager' || req.user?.role === 'admin' || req.user?.isSuperAdmin) {
    return next();
  }
  return res.status(403).json({ message: 'Billing access requires staff credentials' });
}

function requireBillingOperator(req, res, next) {
  if (isBillingOperator(req.user)) {
    return next();
  }
  return res.status(403).json({
    message: 'Only Manager or Admin operators can change Billing catalog, invoices, and payments'
  });
}

router.use(requireBillingViewer);

function money(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function nextBillNumber() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `NB-INV-${stamp}-${rand}`;
}

/** Pending payment window — unpaid pending bills expire into failure. */
const PENDING_PAYMENT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

async function expirePendingBills() {
  const now = new Date();
  const cutoff = new Date(Date.now() - PENDING_PAYMENT_TTL_MS);
  const result = await Bill.updateMany(
    {
      paymentStatus: 'pending',
      $or: [
        { paymentExpiresAt: { $ne: null, $lte: now } },
        { $and: [{ $or: [{ paymentExpiresAt: null }, { paymentExpiresAt: { $exists: false } }] }, { updatedAt: { $lte: cutoff } }] }
      ]
    },
    {
      $set: {
        paymentStatus: 'failed',
        statusReason: 'Payment window expired before settlement.'
      }
    }
  );
  return result?.modifiedCount || 0;
}

async function backfillCustomerRewards(customer) {
  if (!customer) {
    return customer;
  }
  const unpaidRewards = await Bill.find({
    customer: customer._id,
    paymentStatus: 'paid',
    rewardsAwarded: { $ne: true }
  });
  if (!unpaidRewards.length) {
    return customer;
  }
  let added = 0;
  for (const bill of unpaidRewards) {
    const points = Math.max(1, Math.floor(Number(bill.grandTotal) || 0));
    added += points;
    bill.rewardsAwarded = true;
    await bill.save();
  }
  if (added > 0) {
    customer.rewardPoints = Number(customer.rewardPoints || 0) + added;
    await customer.save();
  }
  return customer;
}

function paymentRef(method) {
  return `PAY-${String(method || 'X').toUpperCase()}-${Date.now().toString(36).toUpperCase()}-${crypto
    .randomBytes(2)
    .toString('hex')
    .toUpperCase()}`;
}

/**
 * Resolve coupon discount for a cart subtotal / optional payment method.
 * Returns { ok, status, message, coupon?, discount? }.
 * Optional customer / hasBankingAccount / customerId for bank-kind coupons.
 */
async function resolveCouponDiscount({
  code,
  subtotal,
  paymentMethod,
  customer,
  hasBankingAccount,
  customerId
}) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) {
    return { ok: false, status: 400, message: 'Coupon code is required' };
  }
  const coupon = await BillingCoupon.findOne({ code: normalized });
  if (!coupon || coupon.active === false) {
    return { ok: false, status: 404, message: 'Coupon not found or inactive' };
  }
  if (coupon.isExpired()) {
    return { ok: false, status: 400, message: 'Coupon has expired' };
  }
  if (coupon.isExhausted()) {
    return { ok: false, status: 400, message: 'Coupon usage limit reached' };
  }
  const base = money(subtotal);
  if (base < money(coupon.minSubtotal || 0)) {
    return {
      ok: false,
      status: 400,
      message: `Minimum subtotal of ${money(coupon.minSubtotal).toFixed(2)} required for this coupon`
    };
  }

  let bankingOk =
    typeof hasBankingAccount === 'boolean'
      ? hasBankingAccount
      : customer
        ? Boolean(String(customer.bankingAccountNumber || '').trim())
        : null;
  if (bankingOk == null && customerId) {
    const loaded = await BillingCustomer.findById(customerId).select('bankingAccountNumber');
    bankingOk = Boolean(loaded && String(loaded.bankingAccountNumber || '').trim());
  }

  if (coupon.kind === 'bank' && !bankingOk) {
    return {
      ok: false,
      status: 400,
      message: 'Bank-linked coupons require a customer with a banking account number'
    };
  }

  if (paymentMethod && !coupon.allowsPaymentMethod(paymentMethod)) {
    return {
      ok: false,
      status: 400,
      message: `Coupon ${coupon.code} cannot be used with ${String(paymentMethod).toUpperCase()} payments`
    };
  }
  const discount = coupon.computeDiscount(base);
  if (discount <= 0) {
    return { ok: false, status: 400, message: 'Coupon does not apply to this cart' };
  }
  return { ok: true, coupon, discount };
}

/** Soft-expire coupons past their expiresAt while still marked active. */
async function expireCouponsNow() {
  const now = new Date();
  await BillingCoupon.updateMany(
    { active: true, expiresAt: { $ne: null, $lt: now } },
    { $set: { active: false } }
  );
}

/**
 * Auto-remove expired catalog products: deactivate, zero stock, notify once.
 * Mirrors coupon expiry — called from product list/get (and create/update).
 */
async function expireProductsNow() {
  const now = new Date();
  const due = await BillingProduct.find({
    active: true,
    expiresAt: { $ne: null, $lte: now }
  }).limit(100);
  if (!due.length) {
    return 0;
  }
  for (const product of due) {
    product.active = false;
    product.stock = 0;
    if (!product.expiredAt) {
      product.expiredAt = now;
    }
    const shouldNotify = !product.expiredNotified;
    if (shouldNotify) {
      product.expiredNotified = true;
    }
    await product.save();
    if (shouldNotify) {
      try {
        await notifyManagers(
          'billing',
          'Product auto-expired',
          `${product.name}${product.sku ? ` (${product.sku})` : ''} expired and was removed from the shop catalog.`,
          '/billing/products'
        );
      } catch (notifyError) {
        console.warn('Product expiry notify failed:', notifyError.message);
      }
    }
  }
  return due.length;
}

function slugifyCategory(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function parseExpiresAt(raw) {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (raw == null || raw === '') {
    return { ok: true, value: null };
  }
  const expiresAt = new Date(raw);
  if (Number.isNaN(expiresAt.getTime())) {
    return { ok: false, message: 'Invalid product expiry date' };
  }
  return { ok: true, value: expiresAt };
}

/* ---------- Sales target reports (paid bills) ---------- */

function resolveSalesDateRange(query) {
  const preset = String(query.range || query.preset || 'last_month')
    .trim()
    .toLowerCase();
  const cadenceRaw = String(query.cadence || 'weekly')
    .trim()
    .toLowerCase();
  const cadence = ['daily', 'weekly', 'biweekly', 'monthly'].includes(cadenceRaw)
    ? cadenceRaw
    : 'weekly';

  const now = new Date();
  let to = new Date(now);
  to.setHours(23, 59, 59, 999);
  let from = new Date(now);
  from.setHours(0, 0, 0, 0);

  const daySpans = {
    last_week: 7,
    last_month: 30,
    last_3_months: 90,
    last_6_months: 180,
    last_year: 365
  };

  if (preset === 'custom') {
    const fromRaw = String(query.from || '').trim();
    const toRaw = String(query.to || '').trim();
    if (fromRaw) {
      from = new Date(fromRaw);
      from.setHours(0, 0, 0, 0);
    } else {
      from.setDate(from.getDate() - 29);
    }
    if (toRaw) {
      to = new Date(toRaw);
      to.setHours(23, 59, 59, 999);
    }
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      from = new Date(now);
      from.setHours(0, 0, 0, 0);
      from.setDate(from.getDate() - 29);
      to = new Date(now);
      to.setHours(23, 59, 59, 999);
    }
  } else {
    const days = daySpans[preset] || daySpans.last_month;
    from.setDate(from.getDate() - (days - 1));
  }

  return { cadence, range: preset === 'custom' ? 'custom' : preset in daySpans ? preset : 'last_month', from, to };
}

function paidBillDateMatch(from, to) {
  return {
    paymentStatus: 'paid',
    $or: [
      { paidAt: { $gte: from, $lte: to } },
      {
        $and: [
          { $or: [{ paidAt: null }, { paidAt: { $exists: false } }] },
          { createdAt: { $gte: from, $lte: to } }
        ]
      }
    ]
  };
}

function paidBillEffectiveDateExpr() {
  return {
    $ifNull: ['$paidAt', '$createdAt']
  };
}

function salesSeriesBucketExpr(cadence) {
  const date = paidBillEffectiveDateExpr();
  if (cadence === 'daily') {
    return {
      key: { $dateToString: { format: '%Y-%m-%d', date } },
      sort: date
    };
  }
  if (cadence === 'monthly') {
    return {
      key: { $dateToString: { format: '%Y-%m', date } },
      sort: date
    };
  }
  if (cadence === 'biweekly') {
    return {
      key: {
        $concat: [
          { $dateToString: { format: '%G-', date } },
          {
            $toString: {
              $floor: {
                $divide: [{ $subtract: [{ $isoWeek: date }, 1] }, 2]
              }
            }
          }
        ]
      },
      sort: date
    };
  }
  // weekly (ISO week)
  return {
    key: {
      $concat: [
        { $dateToString: { format: '%G-W', date } },
        {
          $cond: [
            { $lt: [{ $isoWeek: date }, 10] },
            { $concat: ['0', { $toString: { $isoWeek: date } }] },
            { $toString: { $isoWeek: date } }
          ]
        }
      ]
    },
    sort: date
  };
}

function formatSeriesLabel(cadence, key) {
  const raw = String(key || '');
  if (cadence === 'daily') {
    const d = new Date(`${raw}T00:00:00`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
  }
  if (cadence === 'monthly' && /^\d{4}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}-01T00:00:00`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    }
  }
  if (cadence === 'weekly') {
    return raw.replace(/^(\d{4})-W0?/, '$1 W');
  }
  if (cadence === 'biweekly') {
    return raw.replace(/^(\d{4})-/, '$1 B');
  }
  return raw;
}

router.get('/sales-reports', async (req, res) => {
  try {
    const { cadence, range, from, to } = resolveSalesDateRange(req.query || {});
    const match = paidBillDateMatch(from, to);
    const bucket = salesSeriesBucketExpr(cadence);

    const [productSales, customerPurchases, totalsAgg, seriesAgg] = await Promise.all([
      Bill.aggregate([
        { $match: match },
        { $unwind: '$items' },
        {
          $group: {
            _id: {
              productId: '$items.product',
              name: '$items.name'
            },
            qty: { $sum: '$items.quantity' },
            revenue: { $sum: '$items.lineTotal' },
            orders: { $addToSet: '$_id' }
          }
        },
        {
          $project: {
            _id: 0,
            productId: { $toString: '$_id.productId' },
            name: '$_id.name',
            qty: 1,
            revenue: 1,
            orderCount: { $size: '$orders' }
          }
        },
        { $sort: { revenue: -1, name: 1 } }
      ]),
      Bill.aggregate([
        { $match: match },
        {
          $addFields: {
            itemQty: { $sum: '$items.quantity' }
          }
        },
        {
          $group: {
            _id: {
              customerId: '$customer',
              name: '$customerName'
            },
            qty: { $sum: '$itemQty' },
            revenue: { $sum: '$grandTotal' },
            orderCount: { $sum: 1 }
          }
        },
        {
          $project: {
            _id: 0,
            customerId: { $toString: '$_id.customerId' },
            name: '$_id.name',
            qty: 1,
            revenue: 1,
            orderCount: 1
          }
        },
        { $sort: { revenue: -1, name: 1 } }
      ]),
      Bill.aggregate([
        { $match: match },
        {
          $addFields: {
            itemQty: { $sum: '$items.quantity' }
          }
        },
        {
          $group: {
            _id: null,
            revenue: { $sum: '$grandTotal' },
            qty: { $sum: '$itemQty' },
            orderCount: { $sum: 1 }
          }
        }
      ]),
      Bill.aggregate([
        { $match: match },
        {
          $addFields: {
            itemQty: { $sum: '$items.quantity' },
            seriesKey: bucket.key,
            seriesSort: bucket.sort
          }
        },
        {
          $group: {
            _id: '$seriesKey',
            revenue: { $sum: '$grandTotal' },
            qty: { $sum: '$itemQty' },
            orderCount: { $sum: 1 },
            sortAt: { $min: '$seriesSort' }
          }
        },
        { $sort: { sortAt: 1, _id: 1 } }
      ])
    ]);

    const totalsRow = totalsAgg[0] || { revenue: 0, qty: 0, orderCount: 0 };

    return res.json({
      cadence,
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      series: seriesAgg.map((row) => ({
        key: row._id,
        label: formatSeriesLabel(cadence, row._id),
        revenue: money(row.revenue),
        qty: row.qty || 0,
        orderCount: row.orderCount || 0
      })),
      productSales: productSales.map((row) => ({
        name: row.name,
        qty: row.qty || 0,
        revenue: money(row.revenue),
        orderCount: row.orderCount || 0,
        productId: row.productId || null
      })),
      customerPurchases: customerPurchases.map((row) => ({
        name: row.name,
        qty: row.qty || 0,
        revenue: money(row.revenue),
        orderCount: row.orderCount || 0,
        customerId: row.customerId || null
      })),
      totals: {
        revenue: money(totalsRow.revenue),
        qty: totalsRow.qty || 0,
        orderCount: totalsRow.orderCount || 0
      }
    });
  } catch (error) {
    console.error('Billing sales-reports error:', error);
    return res.status(500).json({ message: 'Unable to load sales reports' });
  }
});

/* ---------- Dashboard ---------- */

router.get('/dashboard/stats', async (_req, res) => {
  try {
    const [productCount, customerCount, billCount, paidBills, openComplaints, recentBills, statusGroups] =
      await Promise.all([
        BillingProduct.countDocuments({ active: true }),
        BillingCustomer.countDocuments(),
        Bill.countDocuments(),
        Bill.find({ paymentStatus: 'paid' }).select('grandTotal'),
        BillingComplaint.countDocuments({ status: { $in: ['open', 'escalated'] } }),
        Bill.find().sort({ createdAt: -1 }).limit(6),
        Bill.aggregate([{ $group: { _id: '$paymentStatus', count: { $sum: 1 } } }])
      ]);

    const totalSales = money(paidBills.reduce((sum, b) => sum + (b.grandTotal || 0), 0));
    const statusCounts = {
      draft: 0,
      pending: 0,
      paid: 0,
      failed: 0,
      error: 0,
      refunded: 0
    };
    for (const row of statusGroups) {
      const key = String(row._id || '');
      if (Object.prototype.hasOwnProperty.call(statusCounts, key)) {
        statusCounts[key] = row.count || 0;
      }
    }

    return res.json({
      totalSales,
      totalOrders: billCount,
      totalProducts: productCount,
      totalCustomers: customerCount,
      openComplaints,
      statusCounts,
      recentBills: recentBills.map((b) => b.toSafeJSON())
    });
  } catch (error) {
    console.error('Billing stats error:', error);
    return res.status(500).json({ message: 'Unable to load billing stats' });
  }
});

/* ---------- Products ---------- */

router.get('/products', async (req, res) => {
  try {
    await expireProductsNow();
    const q = String(req.query.q || '').trim();
    const category = String(req.query.category || '').trim();
    const inStock = String(req.query.inStock || '').trim() === '1';
    const activeOnly = String(req.query.active || '').trim() === '1';
    const sortRaw = String(req.query.sort || 'name').trim().toLowerCase();
    const filter = {};
    if (q) {
      filter.$or = [
        { name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { sku: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { category: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
      ];
    }
    if (category) {
      filter.category = new RegExp(`^${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    }
    if (inStock) {
      filter.stock = { $gt: 0 };
      filter.active = true;
    }
    if (activeOnly) {
      filter.active = true;
    }
    let sort = { name: 1 };
    if (sortRaw === 'price_asc') sort = { price: 1, name: 1 };
    else if (sortRaw === 'price_desc') sort = { price: -1, name: 1 };
    else if (sortRaw === 'stock') sort = { stock: -1, name: 1 };
    else if (sortRaw === 'rating') sort = { ratingSum: -1, ratingCount: -1, name: 1 };
    else if (sortRaw === 'newest') sort = { createdAt: -1 };
    const items = await BillingProduct.find(filter).sort(sort);
    return res.json({ items: items.map((p) => p.toSafeJSON()) });
  } catch (error) {
    console.error('Billing products list error:', error);
    return res.status(500).json({ message: 'Unable to load products' });
  }
});

router.post('/products', requireBillingOperator, async (req, res) => {
  try {
    await expireProductsNow();
    const name = String(req.body?.name || '').trim();
    const price = Number(req.body?.price);
    const stock = Number(req.body?.stock);
    const gstPercentage = Number(req.body?.gstPercentage ?? 18);
    if (!name || Number.isNaN(price) || price < 0 || Number.isNaN(stock) || stock < 0) {
      return res.status(400).json({ message: 'Valid name, price, and stock are required' });
    }
    const images = Array.isArray(req.body?.images)
      ? req.body.images.map((u) => String(u || '').trim()).filter(Boolean).slice(0, 8)
      : [];
    const expiry = parseExpiresAt(req.body?.expiresAt);
    if (!expiry.ok) {
      return res.status(400).json({ message: expiry.message });
    }
    const product = await BillingProduct.create({
      name,
      sku: String(req.body?.sku || '').trim(),
      price: money(price),
      stock: Math.floor(stock),
      gstPercentage: Number.isNaN(gstPercentage) ? 18 : gstPercentage,
      active: req.body?.active !== false,
      category: String(req.body?.category || '').trim(),
      images,
      expiresAt: expiry.value === undefined ? null : expiry.value,
      expiredAt: null,
      expiredNotified: false,
      createdBy: req.user._id
    });
    return res.status(201).json({ message: 'Product created', product: product.toSafeJSON() });
  } catch (error) {
    console.error('Billing product create error:', error);
    return res.status(500).json({ message: 'Unable to create product' });
  }
});

router.put('/products/:id', requireBillingOperator, async (req, res) => {
  try {
    await expireProductsNow();
    const product = await BillingProduct.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    if (req.body?.name != null) product.name = String(req.body.name).trim();
    if (req.body?.sku != null) product.sku = String(req.body.sku).trim();
    if (req.body?.price != null) product.price = money(req.body.price);
    if (req.body?.stock != null) product.stock = Math.floor(Number(req.body.stock));
    if (req.body?.gstPercentage != null) product.gstPercentage = Number(req.body.gstPercentage);
    if (req.body?.active != null) product.active = !!req.body.active;
    if (req.body?.category != null) product.category = String(req.body.category).trim();
    if (Array.isArray(req.body?.images)) {
      product.images = req.body.images.map((u) => String(u || '').trim()).filter(Boolean).slice(0, 8);
    }
    if (req.body?.expiresAt !== undefined) {
      const expiry = parseExpiresAt(req.body.expiresAt);
      if (!expiry.ok) {
        return res.status(400).json({ message: expiry.message });
      }
      product.expiresAt = expiry.value;
      if (expiry.value == null) {
        product.expiredAt = null;
        product.expiredNotified = false;
      } else if (expiry.value.getTime() > Date.now() && product.active) {
        product.expiredAt = null;
        product.expiredNotified = false;
      }
    }
    await product.save();
    return res.json({ message: 'Product updated', product: product.toSafeJSON() });
  } catch (error) {
    console.error('Billing product update error:', error);
    return res.status(500).json({ message: 'Unable to update product' });
  }
});

/** Soft archive — product leaves the active catalog but remains in DB. */
router.delete('/products/:id', requireBillingOperator, async (req, res) => {
  try {
    const product = await BillingProduct.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    const hard =
      String(req.query.hard || '').trim() === '1' ||
      String(req.body?.hard || '').trim() === '1' ||
      String(req.body?.mode || '').trim().toLowerCase() === 'hard';
    if (hard) {
      await product.deleteOne();
      return res.json({ message: 'Product permanently deleted' });
    }
    product.active = false;
    product.stock = 0;
    await product.save();
    return res.json({ message: 'Product archived', product: product.toSafeJSON() });
  } catch (error) {
    console.error('Billing product delete error:', error);
    return res.status(500).json({ message: 'Unable to archive product' });
  }
});

/** Explicit hard delete (clearer remove). */
router.post('/products/:id/purge', requireBillingOperator, async (req, res) => {
  try {
    const product = await BillingProduct.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    const name = product.name;
    await product.deleteOne();
    return res.json({ message: `Product “${name}” permanently deleted` });
  } catch (error) {
    console.error('Billing product purge error:', error);
    return res.status(500).json({ message: 'Unable to delete product' });
  }
});

router.post('/products/bulk', requireBillingOperator, async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!rows.length) {
      return res.status(400).json({ message: 'At least one product row is required' });
    }
    if (rows.length > 200) {
      return res.status(400).json({ message: 'Bulk upload is limited to 200 products per request' });
    }

    const existing = await BillingProduct.find({ active: true }).select('sku name');
    const existingSkus = new Set(
      existing.map((p) => String(p.sku || '').trim().toLowerCase()).filter(Boolean)
    );
    const existingNames = new Set(
      existing.map((p) => String(p.name || '').trim().toLowerCase()).filter(Boolean)
    );
    const batchSkus = new Set();
    const batchNames = new Set();
    const created = [];
    const errors = [];

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i] || {};
      const name = String(row.name || '').trim();
      const sku = String(row.sku || '').trim();
      const price = Number(row.price);
      const stock = Number(row.stock);
      const gstPercentage = Number(row.gstPercentage ?? 18);
      const category = String(row.category || '').trim();
      const issues = [];

      if (!name || name.length < 2) issues.push('Name is required (min 2 characters)');
      if (Number.isNaN(price) || price < 0) issues.push('Valid price (>= 0) is required');
      if (Number.isNaN(stock) || stock < 0) issues.push('Valid stock (>= 0) is required');
      if (Number.isNaN(gstPercentage) || gstPercentage < 0 || gstPercentage > 100) {
        issues.push('GST must be between 0 and 100');
      }
      const skuKey = sku.toLowerCase();
      const nameKey = name.toLowerCase();
      if (skuKey && (existingSkus.has(skuKey) || batchSkus.has(skuKey))) {
        issues.push('Duplicate SKU');
      }
      if (nameKey && (existingNames.has(nameKey) || batchNames.has(nameKey))) {
        issues.push('Duplicate product name');
      }

      if (issues.length) {
        errors.push({ index: i, name, sku, message: issues.join('; ') });
        continue;
      }

      try {
        const product = await BillingProduct.create({
          name,
          sku,
          price: money(price),
          stock: Math.floor(stock),
          gstPercentage,
          active: true,
          category,
          images: [],
          createdBy: req.user._id
        });
        created.push(product.toSafeJSON());
        if (skuKey) {
          existingSkus.add(skuKey);
          batchSkus.add(skuKey);
        }
        if (nameKey) {
          existingNames.add(nameKey);
          batchNames.add(nameKey);
        }
      } catch (err) {
        errors.push({ index: i, name, sku, message: err.message || 'Unable to create product' });
      }
    }

    return res.status(created.length ? 201 : 400).json({
      message: created.length
        ? `Uploaded ${created.length} product${created.length === 1 ? '' : 's'}`
        : 'No products were uploaded',
      created,
      errors,
      createdCount: created.length,
      errorCount: errors.length
    });
  } catch (error) {
    console.error('Billing products bulk error:', error);
    return res.status(500).json({ message: 'Unable to bulk upload products' });
  }
});

/* ---------- Customers ---------- */

router.get('/customers', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const filter = {};
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: new RegExp(safe, 'i') },
        { email: new RegExp(safe, 'i') },
        { phone: new RegExp(safe, 'i') },
        { bankingAccountNumber: new RegExp(safe, 'i') }
      ];
    }
    const items = await BillingCustomer.find(filter).sort({ name: 1 });
    const synced = [];
    for (const customer of items) {
      synced.push(await backfillCustomerRewards(customer));
    }
    return res.json({ items: synced.map((c) => c.toSafeJSON()) });
  } catch (error) {
    console.error('Billing customers list error:', error);
    return res.status(500).json({ message: 'Unable to load customers' });
  }
});

router.post('/customers', requireBillingOperator, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ message: 'Customer name is required' });
    }
    const customer = await BillingCustomer.create({
      name,
      email: String(req.body?.email || '').trim().toLowerCase(),
      phone: String(req.body?.phone || '').trim(),
      address: String(req.body?.address || '').trim(),
      bankingAccountNumber: String(req.body?.bankingAccountNumber || '').trim() || null,
      createdBy: req.user._id
    });
    return res.status(201).json({ message: 'Customer created', customer: customer.toSafeJSON() });
  } catch (error) {
    console.error('Billing customer create error:', error);
    return res.status(500).json({ message: 'Unable to create customer' });
  }
});

router.put('/customers/:id', requireBillingOperator, async (req, res) => {
  try {
    const customer = await BillingCustomer.findById(req.params.id);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    if (req.body?.name != null) customer.name = String(req.body.name).trim();
    if (req.body?.email != null) customer.email = String(req.body.email).trim().toLowerCase();
    if (req.body?.phone != null) customer.phone = String(req.body.phone).trim();
    if (req.body?.address != null) customer.address = String(req.body.address).trim();
    if (req.body?.bankingAccountNumber !== undefined) {
      customer.bankingAccountNumber = String(req.body.bankingAccountNumber || '').trim() || null;
    }
    await customer.save();
    return res.json({ message: 'Customer updated', customer: customer.toSafeJSON() });
  } catch (error) {
    console.error('Billing customer update error:', error);
    return res.status(500).json({ message: 'Unable to update customer' });
  }
});

router.delete('/customers/:id', requireBillingOperator, async (req, res) => {
  try {
    const customer = await BillingCustomer.findByIdAndDelete(req.params.id);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    return res.json({ message: 'Customer removed' });
  } catch (error) {
    console.error('Billing customer delete error:', error);
    return res.status(500).json({ message: 'Unable to remove customer' });
  }
});

router.post('/customers/bulk', requireBillingOperator, async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!rows.length) {
      return res.status(400).json({ message: 'At least one customer row is required' });
    }
    if (rows.length > 200) {
      return res.status(400).json({ message: 'Bulk upload is limited to 200 customers per request' });
    }

    const existing = await BillingCustomer.find().select('email phone name bankingAccountNumber');
    const existingEmails = new Set(
      existing.map((c) => String(c.email || '').trim().toLowerCase()).filter(Boolean)
    );
    const existingPhones = new Set(
      existing.map((c) => String(c.phone || '').trim().toLowerCase()).filter(Boolean)
    );
    const existingAccounts = new Set(
      existing.map((c) => String(c.bankingAccountNumber || '').trim().toLowerCase()).filter(Boolean)
    );
    const batchEmails = new Set();
    const batchPhones = new Set();
    const batchAccounts = new Set();
    const created = [];
    const errors = [];

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i] || {};
      const name = String(row.name || '').trim();
      const email = String(row.email || '').trim().toLowerCase();
      const phone = String(row.phone || '').trim();
      const address = String(row.address || '').trim();
      const bankingAccountNumber = String(row.bankingAccountNumber || '').trim() || null;
      const issues = [];

      if (!name || name.length < 2) issues.push('Name is required (min 2 characters)');
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) issues.push('Invalid email');
      if (email && (existingEmails.has(email) || batchEmails.has(email))) issues.push('Duplicate email');
      if (phone && (existingPhones.has(phone.toLowerCase()) || batchPhones.has(phone.toLowerCase()))) {
        issues.push('Duplicate phone');
      }
      if (
        bankingAccountNumber &&
        (existingAccounts.has(bankingAccountNumber.toLowerCase()) ||
          batchAccounts.has(bankingAccountNumber.toLowerCase()))
      ) {
        issues.push('Duplicate banking account number');
      }

      if (issues.length) {
        errors.push({ index: i, name, email, phone, message: issues.join('; ') });
        continue;
      }

      try {
        const customer = await BillingCustomer.create({
          name,
          email,
          phone,
          address,
          bankingAccountNumber,
          createdBy: req.user._id
        });
        created.push(customer.toSafeJSON());
        if (email) {
          existingEmails.add(email);
          batchEmails.add(email);
        }
        if (phone) {
          existingPhones.add(phone.toLowerCase());
          batchPhones.add(phone.toLowerCase());
        }
        if (bankingAccountNumber) {
          existingAccounts.add(bankingAccountNumber.toLowerCase());
          batchAccounts.add(bankingAccountNumber.toLowerCase());
        }
      } catch (err) {
        errors.push({
          index: i,
          name,
          email,
          phone,
          message: err.message || 'Unable to create customer'
        });
      }
    }

    return res.status(created.length ? 201 : 400).json({
      message: created.length
        ? `Uploaded ${created.length} customer${created.length === 1 ? '' : 's'}`
        : 'No customers were uploaded',
      created,
      errors,
      createdCount: created.length,
      errorCount: errors.length
    });
  } catch (error) {
    console.error('Billing customers bulk error:', error);
    return res.status(500).json({ message: 'Unable to bulk upload customers' });
  }
});

/* ---------- Bills ---------- */

router.get('/bills', async (req, res) => {
  try {
    await expirePendingBills();
    const filter = {};
    const billId = String(req.query.billId || req.query.q || '').trim();
    const customerId = String(req.query.customerId || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const paymentStatus = String(req.query.paymentStatus || '').trim().toLowerCase();

    if (billId) {
      filter.$or = [
        { billNumber: new RegExp(billId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { customerName: new RegExp(billId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
      ];
    }
    if (customerId) filter.customer = customerId;
    if (paymentStatus && ['draft', 'pending', 'paid', 'failed', 'error', 'refunded'].includes(paymentStatus)) {
      filter.paymentStatus = paymentStatus;
    }
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(5, Number(req.query.limit) || 12));
    const skip = (page - 1) * limit;
    const sortField = String(req.query.sort || 'createdAt').trim();
    const orderRaw = String(req.query.order || 'desc').trim().toLowerCase();
    const allowedSort = ['createdAt', 'paidAt', 'grandTotal', 'billNumber'];
    const sortKey = allowedSort.includes(sortField) ? sortField : 'createdAt';
    const sortDir = orderRaw === 'asc' ? 1 : -1;
    const [total, items] = await Promise.all([
      Bill.countDocuments(filter),
      Bill.find(filter).sort({ [sortKey]: sortDir }).skip(skip).limit(limit)
    ]);

    return res.json({
      items: items.map((b) => b.toSafeJSON()),
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit))
    });
  } catch (error) {
    console.error('Billing bills list error:', error);
    return res.status(500).json({ message: 'Unable to load bills' });
  }
});

router.get('/bills/:id', async (req, res) => {
  try {
    await expirePendingBills();
    const bill = await Bill.findById(req.params.id);
    if (!bill) {
      return res.status(404).json({ message: 'Bill not found' });
    }
    const payments = await Payment.find({ bill: bill._id }).sort({ createdAt: -1 });
    return res.json({
      bill: bill.toSafeJSON(),
      payments: payments.map((p) => p.toSafeJSON())
    });
  } catch (error) {
    console.error('Billing bill detail error:', error);
    return res.status(500).json({ message: 'Unable to load bill' });
  }
});

router.post('/bills', requireBillingOperator, async (req, res) => {
  try {
    const customerId = String(req.body?.customerId || '').trim();
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    let discount = money(req.body?.discount || 0);
    const couponCodeRaw = String(req.body?.couponCode || '').trim().toUpperCase();
    if (!customerId || !rawItems.length) {
      return res.status(400).json({ message: 'Customer and at least one line item are required' });
    }

    const customer = await BillingCustomer.findById(customerId);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const items = [];
    let subtotal = 0;
    let tax = 0;

    for (const row of rawItems) {
      const product = await BillingProduct.findById(row.productId);
      if (!product || !product.active) {
        return res.status(400).json({ message: `Product unavailable: ${row.productId}` });
      }
      const quantity = Math.max(1, Math.floor(Number(row.quantity) || 1));
      if (product.stock < quantity) {
        return res.status(400).json({ message: `Insufficient stock for ${product.name}` });
      }
      const unitPrice = money(product.price);
      const gstPercentage = Number(product.gstPercentage) || 0;
      const lineNet = money(unitPrice * quantity);
      const lineTax = money((lineNet * gstPercentage) / 100);
      subtotal = money(subtotal + lineNet);
      tax = money(tax + lineTax);
      items.push({
        product: product._id,
        name: product.name,
        quantity,
        unitPrice,
        gstPercentage,
        lineTotal: money(lineNet + lineTax)
      });
      product.stock -= quantity;
      await product.save();
    }

    let couponDoc = null;
    if (couponCodeRaw) {
      const resolved = await resolveCouponDiscount({
        code: couponCodeRaw,
        subtotal,
        paymentMethod: req.body?.paymentMethod,
        customer,
        hasBankingAccount: Boolean(String(customer.bankingAccountNumber || '').trim()),
        customerId
      });
      if (!resolved.ok) {
        return res.status(resolved.status || 400).json({ message: resolved.message });
      }
      couponDoc = resolved.coupon;
      discount = money(resolved.discount);
    }

    const safeDiscount = Math.min(discount, subtotal);
    const taxableBase = money(subtotal - safeDiscount);
    // Re-scale tax proportionally after discount on net.
    const scale = subtotal > 0 ? taxableBase / subtotal : 0;
    const finalTax = money(tax * scale);
    const grandTotal = money(taxableBase + finalTax);

    const bill = await Bill.create({
      billNumber: nextBillNumber(),
      customer: customer._id,
      customerName: customer.name,
      bankingAccountNumber: customer.bankingAccountNumber || null,
      items,
      subtotal,
      discount: safeDiscount,
      couponCode: couponDoc ? couponDoc.code : null,
      couponId: couponDoc ? couponDoc._id : null,
      tax: finalTax,
      grandTotal,
      paymentStatus: 'draft',
      notes: String(req.body?.notes || '').trim(),
      createdBy: req.user._id
    });

    if (couponDoc) {
      couponDoc.usedCount = Number(couponDoc.usedCount || 0) + 1;
      await couponDoc.save();
    }

    await notifyManagers(
      'billing',
      'Invoice created',
      `${bill.billNumber} · ${customer.name} · $${grandTotal.toFixed(2)} · bill created`,
      '/notifications'
    );

    try {
      await notifyContact({
        email: customer.email,
        phone: customer.phone,
        title: 'Invoice created',
        body: `Invoice ${bill.billNumber} for $${grandTotal.toFixed(2)} has been created.`
      });
    } catch (notifyError) {
      console.warn('Invoice create customer notify failed:', notifyError.message);
    }

    return res.status(201).json({ message: 'Bill created', bill: bill.toSafeJSON() });
  } catch (error) {
    console.error('Billing bill create error:', error);
    return res.status(500).json({ message: 'Unable to create bill' });
  }
});

router.post('/bills/:id/await-payment', requireBillingOperator, async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) {
      return res.status(404).json({ message: 'Bill not found' });
    }
    if (bill.paymentStatus === 'paid') {
      return res.status(400).json({ message: 'Bill is already paid' });
    }
    bill.paymentStatus = 'pending';
    bill.paymentExpiresAt = new Date(Date.now() + PENDING_PAYMENT_TTL_MS);
    bill.statusReason = '';
    await bill.save();
    await notifyManagers(
      'billing',
      'Invoice payment pending',
      `${bill.billNumber} · $${bill.grandTotal.toFixed(2)} awaiting payment (expires ${bill.paymentExpiresAt.toISOString()})`,
      '/notifications'
    );
    return res.json({ message: 'Bill awaiting payment', bill: bill.toSafeJSON() });
  } catch (error) {
    console.error('Billing await-payment error:', error);
    return res.status(500).json({ message: 'Unable to update bill' });
  }
});

async function restoreBillStock(bill) {
  for (const item of bill.items || []) {
    const productId = item.product?.toString?.() || String(item.product || '');
    if (!productId) {
      continue;
    }
    const product = await BillingProduct.findById(productId);
    if (product) {
      product.stock = Math.max(0, Number(product.stock || 0) + Math.max(0, Number(item.quantity) || 0));
      await product.save();
    }
  }
}

/** Soft-cancel a pending bill: mark failed, restore stock, keep the invoice in history. */
router.patch('/bills/:id/cancel', requireBillingOperator, async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) {
      return res.status(404).json({ message: 'Bill not found' });
    }
    if (bill.paymentStatus !== 'pending') {
      return res.status(400).json({ message: 'Only payment-pending invoices can be cancelled' });
    }
    const statusReason = String(req.body?.statusReason || '').trim();
    if (!statusReason) {
      return res.status(400).json({ message: 'statusReason is required' });
    }

    await restoreBillStock(bill);
    await Payment.deleteMany({ bill: bill._id });

    bill.paymentStatus = 'failed';
    bill.statusReason = statusReason.slice(0, 240);
    bill.paymentExpiresAt = null;
    await bill.save();

    await notifyManagers(
      'billing',
      'Invoice cancelled',
      `${bill.billNumber} · ${bill.customerName} · $${Number(bill.grandTotal || 0).toFixed(2)} · ${bill.statusReason}`,
      '/notifications'
    );

    return res.json({ message: 'Bill cancelled', bill: bill.toSafeJSON() });
  } catch (error) {
    console.error('Billing bill cancel error:', error);
    return res.status(500).json({ message: 'Unable to cancel bill' });
  }
});

router.delete('/bills/:id', requireBillingOperator, async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) {
      return res.status(404).json({ message: 'Bill not found' });
    }
    const deletable = ['draft', 'pending', 'failed', 'error'];
    if (!deletable.includes(bill.paymentStatus)) {
      return res.status(400).json({
        message: 'Only unpaid invoices (bill created, payment pending, failed, or error) can be deleted'
      });
    }
    const expiredFailure =
      bill.paymentStatus === 'failed' &&
      String(bill.statusReason || '')
        .toLowerCase()
        .includes('payment window expired');
    if (expiredFailure) {
      return res.status(400).json({
        message: 'Expired payment-failure invoices cannot be deleted. Contact a Super Admin if needed.'
      });
    }

    const statusReason = String(req.body?.statusReason || req.query?.statusReason || '').trim();
    if (statusReason) {
      bill.statusReason = statusReason.slice(0, 240);
    } else if (!String(bill.statusReason || '').trim()) {
      bill.statusReason = 'Deleted by staff before settlement.';
    }

    await restoreBillStock(bill);

    await Payment.deleteMany({ bill: bill._id });
    await bill.deleteOne();

    await notifyManagers(
      'billing',
      'Invoice deleted',
      `${bill.billNumber} · ${bill.customerName} · $${Number(bill.grandTotal || 0).toFixed(2)} removed` +
        (bill.statusReason ? ` · ${bill.statusReason}` : ''),
      '/notifications'
    );

    return res.json({ message: 'Bill deleted' });
  } catch (error) {
    console.error('Billing bill delete error:', error);
    return res.status(500).json({ message: 'Unable to delete bill' });
  }
});

/* ---------- Purchases (paid line items) ---------- */

router.get('/purchases', async (req, res) => {
  try {
    await expirePendingBills();
    const q = String(req.query.q || '').trim();
    const customerId = String(req.query.customerId || '').trim();
    const productId = String(req.query.productId || '').trim();
    const method = String(req.query.paymentMethod || '').trim().toLowerCase();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();

    const filter = { paymentStatus: 'paid' };
    if (customerId) filter.customer = customerId;
    if (method && ['cash', 'card', 'upi', 'qr'].includes(method)) {
      filter.paymentMethod = method;
    }
    if (from || to) {
      filter.paidAt = {};
      if (from) filter.paidAt.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        filter.paidAt.$lte = end;
      }
    }
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { billNumber: new RegExp(safe, 'i') },
        { customerName: new RegExp(safe, 'i') },
        { 'items.name': new RegExp(safe, 'i') }
      ];
    }

    const bills = await Bill.find(filter).sort({ paidAt: -1, createdAt: -1 }).limit(400);
    let rows = [];
    for (const bill of bills) {
      for (const item of bill.items || []) {
        const pid = item.product?.toString?.() || String(item.product || '');
        if (productId && pid !== productId) {
          continue;
        }
        rows.push({
          id: `${bill._id.toString()}:${pid}:${item.name}`,
          billId: bill._id.toString(),
          billNumber: bill.billNumber,
          customerId: bill.customer?.toString?.() || String(bill.customer),
          customerName: bill.customerName,
          productId: pid,
          productName: item.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
          paymentMethod: bill.paymentMethod || null,
          paymentStatus: bill.paymentStatus,
          paidAt: bill.paidAt ? bill.paidAt.toISOString?.() || bill.paidAt : null,
          createdAt: bill.createdAt ? bill.createdAt.toISOString?.() || bill.createdAt : null,
          rated: !!bill.ratedAt,
          grandTotal: bill.grandTotal
        });
      }
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(5, Number(req.query.limit) || 12));
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    rows = rows.slice(start, start + limit);

    return res.json({ items: rows, page, limit, total, pages });
  } catch (error) {
    console.error('Billing purchases list error:', error);
    return res.status(500).json({ message: 'Unable to load purchases' });
  }
});

router.post('/bills/:id/ratings', requireBillingOperator, async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) {
      return res.status(404).json({ message: 'Bill not found' });
    }
    if (bill.paymentStatus !== 'paid') {
      return res.status(400).json({ message: 'Only paid invoices can be rated' });
    }
    if (bill.ratedAt) {
      return res.status(400).json({ message: 'This invoice has already been rated' });
    }

    const ratings = Array.isArray(req.body?.ratings) ? req.body.ratings : [];
    if (!ratings.length) {
      return res.status(400).json({ message: 'At least one product rating is required' });
    }

    const billProductIds = new Set(
      (bill.items || []).map((item) => {
        const raw = item.product;
        if (raw && typeof raw === 'object' && raw._id) {
          return String(raw._id);
        }
        return raw?.toString?.() || String(raw || '');
      })
    );
    const updatedProducts = [];

    for (const row of ratings) {
      const productId = String(row?.productId || '').trim();
      const stars = Math.floor(Number(row?.stars));
      if (!productId || !billProductIds.has(productId)) {
        return res.status(400).json({ message: `Product ${productId || '(missing)'} is not on this invoice` });
      }
      if (!(stars >= 1 && stars <= 5)) {
        return res.status(400).json({ message: 'Each rating must be an integer from 1 to 5 stars' });
      }

      const product = await BillingProduct.findByIdAndUpdate(
        productId,
        { $inc: { ratingSum: stars, ratingCount: 1 } },
        { new: true }
      );
      if (!product) {
        return res.status(404).json({ message: `Product not found: ${productId}` });
      }
      updatedProducts.push(product.toSafeJSON());
    }

    bill.ratedAt = new Date();
    await bill.save();

    return res.json({ message: 'Ratings saved', products: updatedProducts });
  } catch (error) {
    console.error('Billing bill ratings error:', error);
    return res.status(500).json({ message: 'Unable to save ratings' });
  }
});

/* ---------- Payments (fake gateway) ---------- */

router.get('/payments', async (req, res) => {
  try {
    const filter = {};
    if (req.query.billId) filter.bill = req.query.billId;
    const items = await Payment.find(filter).sort({ createdAt: -1 }).limit(100);
    return res.json({ items: items.map((p) => p.toSafeJSON()) });
  } catch (error) {
    console.error('Billing payments list error:', error);
    return res.status(500).json({ message: 'Unable to load payments' });
  }
});

router.post('/payments', requireBillingOperator, async (req, res) => {
  try {
    const billId = String(req.body?.billId || '').trim();
    const paymentMethod = String(req.body?.paymentMethod || '').trim().toLowerCase();
    const simulateFail = !!req.body?.simulateFail;
    const simulateError = !!req.body?.simulateError;

    if (!billId || !['cash', 'card', 'upi', 'qr'].includes(paymentMethod)) {
      return res.status(400).json({ message: 'billId and a valid paymentMethod are required' });
    }

    const bill = await Bill.findById(billId);
    if (!bill) {
      return res.status(404).json({ message: 'Bill not found' });
    }
    if (bill.paymentStatus === 'paid') {
      return res.status(400).json({ message: 'Bill is already paid' });
    }

    let status = 'success';
    if (simulateError) {
      status = 'error';
    } else if (simulateFail) {
      status = 'failed';
    }
    const payment = await Payment.create({
      bill: bill._id,
      billNumber: bill.billNumber,
      paymentMethod,
      status: status === 'success' ? 'success' : status === 'error' ? 'error' : 'failed',
      amount: bill.grandTotal,
      transactionRef: paymentRef(paymentMethod),
      meta: {
        gateway: 'novapay-checkout',
        provider: String(req.body?.provider || 'novapay'),
        sessionId: String(req.body?.sessionId || crypto.randomBytes(8).toString('hex')),
        channel: String(req.body?.channel || 'portal-modal'),
        qrToken: paymentMethod === 'qr' ? crypto.randomBytes(8).toString('hex') : undefined,
        cardLast4: req.body?.cardLast4 ? String(req.body.cardLast4).slice(-4) : undefined,
        upiVpa: req.body?.upiVpa ? String(req.body.upiVpa).trim() : undefined,
        outcome: status
      },
      createdBy: req.user._id
    });

    bill.paymentStatus = status === 'success' ? 'paid' : status === 'error' ? 'error' : 'failed';
    bill.paymentMethod = paymentMethod;
    if (status === 'success') {
      bill.paidAt = new Date();
      bill.paymentExpiresAt = null;
      bill.statusReason = '';
    } else if (status === 'error') {
      bill.statusReason = 'Gateway error while processing payment.';
    } else {
      bill.statusReason = 'Payment declined by the simulated gateway.';
    }
    await bill.save();

    if (status === 'success') {
      await notifyManagers(
        'billing',
        'Invoice paid',
        `${bill.billNumber} settled via ${paymentMethod.toUpperCase()} · $${bill.grandTotal.toFixed(2)}`,
        '/notifications'
      );

      try {
        const customer = await BillingCustomer.findById(bill.customer);
        if (customer) {
          await notifyContact({
            email: customer.email,
            phone: customer.phone,
            title: 'Invoice paid',
            body: `Invoice ${bill.billNumber} for $${Number(bill.grandTotal || 0).toFixed(2)} has been paid. Thank you!`
          });

          if (!bill.rewardsAwarded) {
            const points = Math.max(1, Math.floor(Number(bill.grandTotal) || 0));
            customer.rewardPoints = Number(customer.rewardPoints || 0) + points;
            await customer.save();
            bill.rewardsAwarded = true;
            await bill.save();

            await notifyContact({
              email: customer.email,
              phone: customer.phone,
              title: 'Rewards earned',
              body: `You earned ${points} reward point${points === 1 ? '' : 's'} for invoice ${bill.billNumber}. Balance: ${customer.rewardPoints}.`
            });
          }
        }
      } catch (notifyError) {
        console.warn('Invoice paid customer notify/rewards failed:', notifyError.message);
      }
    } else if (status === 'error') {
      await notifyManagers(
        'billing',
        'Invoice payment error',
        `${bill.billNumber} · ${paymentMethod.toUpperCase()} · $${bill.grandTotal.toFixed(2)} · gateway error`,
        '/notifications'
      );
    } else {
      await notifyManagers(
        'billing',
        'Invoice payment failure',
        `${bill.billNumber} · ${paymentMethod.toUpperCase()} · $${bill.grandTotal.toFixed(2)} · declined`,
        '/notifications'
      );
    }

    const message =
      status === 'success'
        ? 'Payment successful'
        : status === 'error'
          ? 'Payment error (simulated gateway fault)'
          : 'Payment failed (simulated decline)';

    return res.status(201).json({
      message,
      payment: payment.toSafeJSON(),
      bill: bill.toSafeJSON()
    });
  } catch (error) {
    console.error('Billing payment error:', error);
    return res.status(500).json({ message: 'Unable to process payment' });
  }
});

router.get('/complaints', async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const filter = {};
    if (status) filter.status = status;
    const items = await BillingComplaint.find(filter).sort({ createdAt: -1 }).limit(100);
    return res.json({ items: items.map((c) => c.toSafeJSON()) });
  } catch (error) {
    console.error('Billing complaints list error:', error);
    return res.status(500).json({ message: 'Unable to load complaints' });
  }
});

router.post('/complaints', requireBillingOperator, async (req, res) => {
  try {
    const subject = String(req.body?.subject || '').trim();
    const detail = String(req.body?.detail || '').trim();
    const customerName = String(req.body?.customerName || '').trim();
    if (!subject || !detail || !customerName) {
      return res.status(400).json({ message: 'customerName, subject, and detail are required' });
    }

    let bill = null;
    if (req.body?.billId) {
      bill = await Bill.findById(req.body.billId);
    }

    const complaint = await BillingComplaint.create({
      bill: bill?._id || null,
      billNumber: bill?.billNumber || String(req.body?.billNumber || '').trim(),
      customer: bill?.customer || req.body?.customerId || null,
      customerName: customerName || bill?.customerName,
      bankingAccountNumber: bill?.bankingAccountNumber || req.body?.bankingAccountNumber || null,
      subject,
      detail,
      status: 'open',
      createdBy: req.user._id
    });

    await notifyManagers(
      'complaint',
      'Billing complaint opened',
      `${complaint.customerName}: ${complaint.subject}`,
      '/manager/billing'
    );
    await notifySuperAdmins(
      'complaint',
      'Billing complaint opened',
      `${complaint.customerName}: ${complaint.subject}`,
      '/manager/billing'
    );

    return res.status(201).json({ message: 'Complaint filed', complaint: complaint.toSafeJSON() });
  } catch (error) {
    console.error('Billing complaint create error:', error);
    return res.status(500).json({ message: 'Unable to file complaint' });
  }
});

router.patch('/complaints/:id', async (req, res) => {
  try {
    const complaint = await BillingComplaint.findById(req.params.id);
    if (!complaint) {
      return res.status(404).json({ message: 'Complaint not found' });
    }

    const action = String(req.body?.action || req.body?.status || '').trim().toLowerCase();
    const note = String(req.body?.resolutionNote || '').trim();
    const allowed = ['accepted', 'adjusted', 'rejected', 'escalated', 'resolved'];
    if (!allowed.includes(action)) {
      return res.status(400).json({
        message: 'action must be accepted, adjusted, rejected, escalated, or resolved'
      });
    }

    if (action === 'escalated' && !(req.user.role === 'admin' || req.user.isSuperAdmin)) {
      // Managers may escalate; Super Admins handle.
    }

    complaint.status = action;
    if (note) complaint.resolutionNote = note;
    complaint.handledBy = req.user._id;
    await complaint.save();

    if (action === 'escalated') {
      await notifySuperAdmins(
        'complaint',
        'Billing complaint escalated',
        `${complaint.customerName}: ${complaint.subject}`,
        '/manager/billing'
      );
    } else {
      await notifyManagers(
        'complaint',
        `Complaint ${action}`,
        `${complaint.customerName}: ${complaint.subject}`,
        '/manager/billing'
      );
    }

    return res.json({ message: `Complaint ${action}`, complaint: complaint.toSafeJSON() });
  } catch (error) {
    console.error('Billing complaint update error:', error);
    return res.status(500).json({ message: 'Unable to update complaint' });
  }
});

/* ---------- Seed sample catalog ---------- */

router.post('/seed', requireBillingOperator, async (req, res) => {
  try {
    const force = !!req.body?.force;
    const productCount = await BillingProduct.countDocuments();
    const customerCount = await BillingCustomer.countDocuments();
    if (!force && productCount > 0 && customerCount > 0) {
      return res.json({
        message: 'Catalog already seeded',
        products: productCount,
        customers: customerCount
      });
    }

    const products = await BillingProduct.insertMany([
      { name: 'Premium Vault Ledger Kit', sku: 'NV-LED-01', price: 49.0, stock: 40, gstPercentage: 18 },
      { name: 'NovaDesk POS Scanner', sku: 'NV-POS-02', price: 129.5, stock: 18, gstPercentage: 18 },
      { name: 'Secure Card Sleeve Pack', sku: 'NV-CRD-03', price: 14.99, stock: 120, gstPercentage: 5 },
      { name: 'Business Statement Bundle', sku: 'NV-STM-04', price: 29.0, stock: 60, gstPercentage: 12 },
      { name: 'Treasury Insight Report', sku: 'NV-RPT-05', price: 79.0, stock: 25, gstPercentage: 18 }
    ]);

    const customers = await BillingCustomer.insertMany([
      {
        name: 'Aurora Trading Co.',
        email: 'accounts@aurora.example',
        phone: '5551002000',
        address: '120 Market Street',
        bankingAccountNumber: null
      },
      {
        name: 'Cedar Retail Group',
        email: 'billing@cedar.example',
        phone: '5551003000',
        address: '88 Harbor Lane',
        bankingAccountNumber: null
      },
      {
        name: 'Summit Advisory LLC',
        email: 'finance@summit.example',
        phone: '5551004000',
        address: '14 Ridge Avenue',
        bankingAccountNumber: null
      }
    ]);

    return res.status(201).json({
      message: 'Billing sample data ready',
      products: products.length,
      customers: customers.length
    });
  } catch (error) {
    console.error('Billing seed error:', error);
    return res.status(500).json({ message: 'Unable to seed billing data' });
  }
});

/* ---------- Categories ---------- */

router.get('/categories', async (req, res) => {
  try {
    const includeInactive = String(req.query.includeInactive || '') === '1';
    const filter = includeInactive ? {} : { active: true };
    let items = await BillingCategory.find(filter).sort({ sortOrder: 1, name: 1 });
    if (!items.length) {
      const defaults = [
        'Grocery',
        'Beverages',
        'Snacks',
        'Electronics',
        'Home',
        'Personal care',
        'Apparel',
        'Stationery'
      ];
      for (let i = 0; i < defaults.length; i += 1) {
        const name = defaults[i];
        const slug = slugifyCategory(name);
        // eslint-disable-next-line no-await-in-loop
        await BillingCategory.findOneAndUpdate(
          { slug },
          {
            $setOnInsert: {
              name,
              slug,
              description: `${name} aisle`,
              active: true,
              sortOrder: i + 1
            }
          },
          { upsert: true, new: true }
        );
      }
      items = await BillingCategory.find(filter).sort({ sortOrder: 1, name: 1 });
    }
    return res.json({ items: items.map((c) => c.toSafeJSON()) });
  } catch (error) {
    console.error('Billing categories list error:', error);
    return res.status(500).json({ message: 'Unable to load categories' });
  }
});

router.post('/categories', requireBillingOperator, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name || name.length < 2) {
      return res.status(400).json({ message: 'Category name is required (min 2 characters)' });
    }
    let slug = String(req.body?.slug || '').trim().toLowerCase() || slugifyCategory(name);
    if (!slug) {
      return res.status(400).json({ message: 'Unable to derive a slug from the category name' });
    }
    const existing = await BillingCategory.findOne({ slug });
    if (existing) {
      return res.status(409).json({ message: 'A category with this slug already exists' });
    }
    const sortOrder = Number(req.body?.sortOrder);
    const category = await BillingCategory.create({
      name,
      slug,
      description: String(req.body?.description || '').trim(),
      active: req.body?.active !== false,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });
    return res.status(201).json({ message: 'Category created', category: category.toSafeJSON() });
  } catch (error) {
    console.error('Billing category create error:', error);
    return res.status(500).json({ message: 'Unable to create category' });
  }
});

router.put('/categories/:id', requireBillingOperator, async (req, res) => {
  try {
    const category = await BillingCategory.findById(req.params.id);
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }
    if (req.body?.name != null) {
      const name = String(req.body.name).trim();
      if (!name || name.length < 2) {
        return res.status(400).json({ message: 'Category name is required (min 2 characters)' });
      }
      category.name = name;
    }
    if (req.body?.slug != null) {
      const slug = String(req.body.slug).trim().toLowerCase() || slugifyCategory(category.name);
      if (!slug) {
        return res.status(400).json({ message: 'Invalid category slug' });
      }
      const clash = await BillingCategory.findOne({ slug, _id: { $ne: category._id } });
      if (clash) {
        return res.status(409).json({ message: 'A category with this slug already exists' });
      }
      category.slug = slug;
    }
    if (req.body?.description != null) {
      category.description = String(req.body.description).trim();
    }
    if (req.body?.sortOrder != null) {
      const sortOrder = Number(req.body.sortOrder);
      category.sortOrder = Number.isFinite(sortOrder) ? sortOrder : 0;
    }
    if (req.body?.active != null) category.active = !!req.body.active;
    category.updatedBy = req.user._id;
    await category.save();
    return res.json({ message: 'Category updated', category: category.toSafeJSON() });
  } catch (error) {
    console.error('Billing category update error:', error);
    return res.status(500).json({ message: 'Unable to update category' });
  }
});

router.post('/categories/:id/deactivate', requireBillingOperator, async (req, res) => {
  try {
    const category = await BillingCategory.findById(req.params.id);
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }
    category.active = false;
    category.updatedBy = req.user._id;
    await category.save();
    return res.json({ message: 'Category deactivated', category: category.toSafeJSON() });
  } catch (error) {
    console.error('Billing category deactivate error:', error);
    return res.status(500).json({ message: 'Unable to deactivate category' });
  }
});

router.delete('/categories/:id', requireBillingOperator, async (req, res) => {
  try {
    const category = await BillingCategory.findById(req.params.id);
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }
    await category.deleteOne();
    return res.json({ message: 'Category deleted' });
  } catch (error) {
    console.error('Billing category delete error:', error);
    return res.status(500).json({ message: 'Unable to delete category' });
  }
});

/* ---------- Coupons ---------- */

router.get('/coupons', async (req, res) => {
  try {
    await expireCouponsNow();
    const includeInactive = String(req.query.includeInactive || '') === '1';
    const filter = includeInactive ? {} : { active: true };
    const items = await BillingCoupon.find(filter).sort({ updatedAt: -1 });
    return res.json({ items: items.map((c) => c.toSafeJSON()) });
  } catch (error) {
    console.error('Billing coupons list error:', error);
    return res.status(500).json({ message: 'Unable to load coupons' });
  }
});

router.post('/coupons/validate', requireBillingOperator, async (req, res) => {
  try {
    await expireCouponsNow();
    const customerId = String(req.body?.customerId || '').trim();
    let hasBankingAccount;
    let customerDoc = null;
    if (customerId) {
      customerDoc = await BillingCustomer.findById(customerId).select('bankingAccountNumber');
      hasBankingAccount = Boolean(
        customerDoc && String(customerDoc.bankingAccountNumber || '').trim()
      );
    }
    const resolved = await resolveCouponDiscount({
      code: req.body?.code,
      subtotal: req.body?.subtotal,
      paymentMethod: req.body?.paymentMethod,
      customerId: customerId || undefined,
      hasBankingAccount,
      customer: customerDoc || undefined
    });
    if (!resolved.ok) {
      return res.status(resolved.status || 400).json({ message: resolved.message });
    }
    return res.json({
      message: 'Coupon applied',
      discount: resolved.discount,
      coupon: resolved.coupon.toSafeJSON()
    });
  } catch (error) {
    console.error('Billing coupon validate error:', error);
    return res.status(500).json({ message: 'Unable to validate coupon' });
  }
});

router.post('/coupons', requireBillingOperator, async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim().toUpperCase();
    const title = String(req.body?.title || '').trim();
    const kind = String(req.body?.kind || 'general').trim().toLowerCase();
    const discountType = String(req.body?.discountType || '').trim().toLowerCase();
    const value = Number(req.body?.value);
    const usageNote = String(req.body?.usageNote || '').trim();
    const bankNote = String(req.body?.bankNote || '').trim();
    const paymentScopes = Array.isArray(req.body?.paymentScopes)
      ? req.body.paymentScopes.map((s) => String(s).toLowerCase())
      : ['any'];

    if (!code || code.length < 3) {
      return res.status(400).json({ message: 'Coupon code must be at least 3 characters' });
    }
    if (!title) {
      return res.status(400).json({ message: 'Coupon title is required' });
    }
    if (!['percent', 'fixed'].includes(discountType)) {
      return res.status(400).json({ message: 'discountType must be percent or fixed' });
    }
    if (!(value >= 0) || (discountType === 'percent' && value > 100)) {
      return res.status(400).json({ message: 'Invalid coupon value' });
    }
    if (!usageNote || usageNote.length < 8) {
      return res.status(400).json({ message: 'Add a short usage note (at least 8 characters)' });
    }
    if (!['general', 'payment', 'bank'].includes(kind)) {
      return res.status(400).json({ message: 'Invalid coupon kind' });
    }
    if (kind === 'bank' && !bankNote) {
      return res.status(400).json({ message: 'Bank coupons require a bank usage note' });
    }
    const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return res.status(400).json({ message: 'Invalid expiry date' });
    }
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: 'Expiry must be in the future' });
    }

    const existing = await BillingCoupon.findOne({ code });
    if (existing) {
      return res.status(409).json({ message: 'Coupon code already exists' });
    }

    const coupon = await BillingCoupon.create({
      code,
      title,
      kind,
      discountType,
      value,
      paymentScopes: paymentScopes.length ? paymentScopes : ['any'],
      usageNote,
      bankNote: kind === 'bank' ? bankNote : bankNote || '',
      minSubtotal: money(req.body?.minSubtotal || 0),
      maxDiscount:
        req.body?.maxDiscount == null || req.body?.maxDiscount === ''
          ? null
          : money(req.body.maxDiscount),
      expiresAt,
      maxUses:
        req.body?.maxUses == null || req.body?.maxUses === ''
          ? null
          : Math.max(1, Math.floor(Number(req.body.maxUses))),
      active: req.body?.active !== false,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    return res.status(201).json({ message: 'Coupon created', coupon: coupon.toSafeJSON() });
  } catch (error) {
    console.error('Billing coupon create error:', error);
    return res.status(500).json({ message: 'Unable to create coupon' });
  }
});

router.put('/coupons/:id', requireBillingOperator, async (req, res) => {
  try {
    const coupon = await BillingCoupon.findById(req.params.id);
    if (!coupon) {
      return res.status(404).json({ message: 'Coupon not found' });
    }

    if (req.body?.title != null) coupon.title = String(req.body.title).trim();
    if (req.body?.kind != null) {
      const kind = String(req.body.kind).trim().toLowerCase();
      if (!['general', 'payment', 'bank'].includes(kind)) {
        return res.status(400).json({ message: 'Invalid coupon kind' });
      }
      coupon.kind = kind;
    }
    if (req.body?.discountType != null) {
      const discountType = String(req.body.discountType).trim().toLowerCase();
      if (!['percent', 'fixed'].includes(discountType)) {
        return res.status(400).json({ message: 'discountType must be percent or fixed' });
      }
      coupon.discountType = discountType;
    }
    if (req.body?.value != null) {
      const value = Number(req.body.value);
      if (!(value >= 0) || (coupon.discountType === 'percent' && value > 100)) {
        return res.status(400).json({ message: 'Invalid coupon value' });
      }
      coupon.value = value;
    }
    if (Array.isArray(req.body?.paymentScopes)) {
      coupon.paymentScopes = req.body.paymentScopes.map((s) => String(s).toLowerCase());
    }
    if (req.body?.usageNote != null) {
      const usageNote = String(req.body.usageNote).trim();
      if (!usageNote || usageNote.length < 8) {
        return res.status(400).json({ message: 'Add a short usage note (at least 8 characters)' });
      }
      coupon.usageNote = usageNote;
    }
    if (req.body?.bankNote != null) coupon.bankNote = String(req.body.bankNote).trim();
    if (coupon.kind === 'bank' && !coupon.bankNote) {
      return res.status(400).json({ message: 'Bank coupons require a bank usage note' });
    }
    if (req.body?.minSubtotal != null) coupon.minSubtotal = money(req.body.minSubtotal);
    if (req.body?.maxDiscount !== undefined) {
      coupon.maxDiscount =
        req.body.maxDiscount == null || req.body.maxDiscount === ''
          ? null
          : money(req.body.maxDiscount);
    }
    if (req.body?.expiresAt !== undefined) {
      if (!req.body.expiresAt) {
        coupon.expiresAt = null;
      } else {
        const expiresAt = new Date(req.body.expiresAt);
        if (Number.isNaN(expiresAt.getTime())) {
          return res.status(400).json({ message: 'Invalid expiry date' });
        }
        coupon.expiresAt = expiresAt;
      }
    }
    if (req.body?.maxUses !== undefined) {
      coupon.maxUses =
        req.body.maxUses == null || req.body.maxUses === ''
          ? null
          : Math.max(1, Math.floor(Number(req.body.maxUses)));
    }
    if (req.body?.active != null) coupon.active = !!req.body.active;
    coupon.updatedBy = req.user._id;
    await coupon.save();
    return res.json({ message: 'Coupon updated', coupon: coupon.toSafeJSON() });
  } catch (error) {
    console.error('Billing coupon update error:', error);
    return res.status(500).json({ message: 'Unable to update coupon' });
  }
});

router.delete('/coupons/:id', requireBillingOperator, async (req, res) => {
  try {
    const coupon = await BillingCoupon.findById(req.params.id);
    if (!coupon) {
      return res.status(404).json({ message: 'Coupon not found' });
    }
    await coupon.deleteOne();
    return res.json({ message: 'Coupon deleted' });
  } catch (error) {
    console.error('Billing coupon delete error:', error);
    return res.status(500).json({ message: 'Unable to delete coupon' });
  }
});

router.post('/coupons/:id/deactivate', requireBillingOperator, async (req, res) => {
  try {
    const coupon = await BillingCoupon.findById(req.params.id);
    if (!coupon) {
      return res.status(404).json({ message: 'Coupon not found' });
    }
    coupon.active = false;
    coupon.updatedBy = req.user._id;
    await coupon.save();
    return res.json({ message: 'Coupon deactivated', coupon: coupon.toSafeJSON() });
  } catch (error) {
    console.error('Billing coupon deactivate error:', error);
    return res.status(500).json({ message: 'Unable to deactivate coupon' });
  }
});

/* ---------- Gateway settings ---------- */

async function getOrCreateSettings() {
  let doc = await BillingSettings.findOne().sort({ updatedAt: -1 });
  if (!doc) {
    doc = await BillingSettings.create({});
  }
  return doc;
}

router.get('/settings', async (_req, res) => {
  try {
    const settings = await getOrCreateSettings();
    return res.json({ settings: settings.toSafeJSON() });
  } catch (error) {
    console.error('Billing settings get error:', error);
    return res.status(500).json({ message: 'Unable to load billing settings' });
  }
});

router.put('/settings', requireBillingOperator, async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    if (req.body?.merchantName != null) settings.merchantName = String(req.body.merchantName).trim();
    if (req.body?.supportNote != null) settings.supportNote = String(req.body.supportNote).trim();
    if (req.body?.upiVpa != null) settings.upiVpa = String(req.body.upiVpa).trim();
    if (req.body?.cardLabel != null) settings.cardLabel = String(req.body.cardLabel).trim();
    if (req.body?.methods && typeof req.body.methods === 'object') {
      settings.methods = {
        cash: req.body.methods.cash !== false,
        card: req.body.methods.card !== false,
        upi: req.body.methods.upi !== false,
        qr: req.body.methods.qr !== false
      };
    }
    settings.updatedBy = req.user._id;
    await settings.save();
    return res.json({ message: 'Gateway settings saved', settings: settings.toSafeJSON() });
  } catch (error) {
    console.error('Billing settings update error:', error);
    return res.status(500).json({ message: 'Unable to save billing settings' });
  }
});

module.exports = router;
