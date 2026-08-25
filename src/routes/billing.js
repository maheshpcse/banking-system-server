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
 */
async function resolveCouponDiscount({ code, subtotal, paymentMethod }) {
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
    const q = String(req.query.q || '').trim();
    const filter = {};
    if (q) {
      filter.$or = [
        { name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { sku: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
      ];
    }
    const items = await BillingProduct.find(filter).sort({ name: 1 });
    return res.json({ items: items.map((p) => p.toSafeJSON()) });
  } catch (error) {
    console.error('Billing products list error:', error);
    return res.status(500).json({ message: 'Unable to load products' });
  }
});

router.post('/products', requireBillingOperator, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const price = Number(req.body?.price);
    const stock = Number(req.body?.stock);
    const gstPercentage = Number(req.body?.gstPercentage ?? 18);
    if (!name || Number.isNaN(price) || price < 0 || Number.isNaN(stock) || stock < 0) {
      return res.status(400).json({ message: 'Valid name, price, and stock are required' });
    }
    const product = await BillingProduct.create({
      name,
      sku: String(req.body?.sku || '').trim(),
      price: money(price),
      stock: Math.floor(stock),
      gstPercentage: Number.isNaN(gstPercentage) ? 18 : gstPercentage,
      active: req.body?.active !== false,
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
    await product.save();
    return res.json({ message: 'Product updated', product: product.toSafeJSON() });
  } catch (error) {
    console.error('Billing product update error:', error);
    return res.status(500).json({ message: 'Unable to update product' });
  }
});

router.delete('/products/:id', requireBillingOperator, async (req, res) => {
  try {
    const product = await BillingProduct.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
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
    const [total, items] = await Promise.all([
      Bill.countDocuments(filter),
      Bill.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
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
        paymentMethod: req.body?.paymentMethod
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

    await Payment.deleteMany({ bill: bill._id });
    await bill.deleteOne();

    await notifyManagers(
      'billing',
      'Invoice deleted',
      `${bill.billNumber} · ${bill.customerName} · $${Number(bill.grandTotal || 0).toFixed(2)} removed`,
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
    const resolved = await resolveCouponDiscount({
      code: req.body?.code,
      subtotal: req.body?.subtotal,
      paymentMethod: req.body?.paymentMethod
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
