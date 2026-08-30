const express = require('express');
const auth = require('../middleware/auth');
const User = require('../models/User');
const BillingProduct = require('../models/BillingProduct');
const BillingCustomer = require('../models/BillingCustomer');
const BillingCoupon = require('../models/BillingCoupon');

const router = express.Router();

const DEMO_PASSWORD = 'Demo@12345';
const DEFAULT_COUNT = 8;
const MAX_COUNT = 40;

const PRODUCT_CATEGORIES = [
  'Stationery',
  'Hardware',
  'Software',
  'Services',
  'Accessories',
  'Reports',
  'Kits'
];
const GST_OPTIONS = [0, 5, 12, 18];
const COUPON_KINDS = BillingCoupon.COUPON_KINDS || ['general', 'payment', 'bank'];
const DISCOUNT_TYPES = BillingCoupon.DISCOUNT_TYPES || ['percent', 'fixed'];
const PAYMENT_SCOPES = BillingCoupon.PAYMENT_SCOPES || ['any', 'cash', 'card', 'upi', 'qr', 'bank'];

let fakerModulePromise;
async function getFaker() {
  if (!fakerModulePromise) {
    fakerModulePromise = import('@faker-js/faker').then((mod) => mod.faker);
  }
  return fakerModulePromise;
}

router.use(auth);

function requireSuperAdmin(req, res, next) {
  if (!req.user?.isSuperAdmin) {
    return res.status(403).json({ message: 'Super Admin access required' });
  }
  return next();
}

router.use(requireSuperAdmin);

function clampCount(value, fallback = DEFAULT_COUNT) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.min(MAX_COUNT, Math.floor(n));
}

function tempId(faker, prefix, index) {
  return `${prefix}-${Date.now().toString(36)}-${index}-${faker.string.alphanumeric(4)}`;
}

function slugUsername(faker, base, index) {
  const clean = String(base || 'staff')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 18);
  return `${clean || 'staff'}${index}${faker.string.alphanumeric(3)}`.toLowerCase();
}

function generateUsers(faker, count) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const role = i % 2 === 0 ? 'manager' : 'admin';
    const first = faker.person.firstName();
    const last = faker.person.lastName();
    const fullName = `${first} ${last}`;
    const username = slugUsername(faker, `${first}.${last}`, i);
    items.push({
      tempId: tempId(faker, 'user', i),
      fullName,
      username,
      email: faker.internet.email({ firstName: first, lastName: last }).toLowerCase(),
      role,
      password: DEMO_PASSWORD,
      staffStatus: 'active'
    });
  }
  return items;
}

function generateProducts(faker, count) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const name = faker.commerce.productName();
    const sku = `NV-${faker.string.alphanumeric({ length: 3, casing: 'upper' })}-${String(i + 1).padStart(2, '0')}`;
    items.push({
      tempId: tempId(faker, 'product', i),
      name,
      sku,
      price: Number(faker.commerce.price({ min: 5, max: 250, dec: 2 })),
      stock: faker.number.int({ min: 5, max: 200 }),
      gstPercentage: faker.helpers.arrayElement(GST_OPTIONS),
      category: faker.helpers.arrayElement(PRODUCT_CATEGORIES),
      active: true
    });
  }
  return items;
}

function generateCustomers(faker, count) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const first = faker.person.firstName();
    const last = faker.person.lastName();
    const includeBank = i % 3 === 0;
    items.push({
      tempId: tempId(faker, 'customer', i),
      name: `${first} ${last}`,
      email: faker.internet.email({ firstName: first, lastName: last }).toLowerCase(),
      phone: faker.phone.number({ style: 'international' }).replace(/\s+/g, '').slice(0, 32),
      address: faker.location.streetAddress({ useFullAddress: true }).slice(0, 240),
      bankingAccountNumber: includeBank
        ? `NB${faker.string.numeric(10)}`
        : undefined,
      rewardPoints: faker.number.int({ min: 0, max: 500 })
    });
  }
  return items;
}

function generateCoupons(faker, count) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const kind = faker.helpers.arrayElement(COUPON_KINDS);
    const discountType = faker.helpers.arrayElement(DISCOUNT_TYPES);
    const value =
      discountType === 'percent'
        ? faker.number.int({ min: 5, max: 25 })
        : Number(faker.commerce.price({ min: 5, max: 40, dec: 2 }));
    const scopePool =
      kind === 'payment'
        ? ['cash', 'card', 'upi', 'qr']
        : kind === 'bank'
          ? ['bank', 'card', 'upi']
          : ['any'];
    items.push({
      tempId: tempId(faker, 'coupon', i),
      code: `${faker.string.alpha({ length: 4, casing: 'upper' })}${faker.string.numeric(3)}`,
      title: faker.commerce.productAdjective() + ' ' + faker.commerce.department() + ' Deal',
      kind,
      discountType,
      value,
      paymentScopes: [faker.helpers.arrayElement(scopePool)],
      usageNote: faker.lorem.sentence({ min: 6, max: 12 }).slice(0, 220),
      minSubtotal: faker.helpers.arrayElement([0, 25, 50, 100]),
      active: true
    });
  }
  return items;
}

router.post('/generate', async (req, res) => {
  try {
    const faker = await getFaker();
    const users = clampCount(req.body?.users);
    const products = clampCount(req.body?.products);
    const customers = clampCount(req.body?.customers);
    const coupons = clampCount(req.body?.coupons);

    return res.json({
      message: 'Demo preview generated (not persisted). Review and commit selected rows.',
      counts: { users, products, customers, coupons },
      users: generateUsers(faker, users),
      products: generateProducts(faker, products),
      customers: generateCustomers(faker, customers),
      coupons: generateCoupons(faker, coupons)
    });
  } catch (error) {
    console.error('Demo generate error:', error);
    return res.status(500).json({ message: 'Unable to generate demo data' });
  }
});

router.post('/commit', async (req, res) => {
  try {
    const usersIn = Array.isArray(req.body?.users) ? req.body.users : [];
    const productsIn = Array.isArray(req.body?.products) ? req.body.products : [];
    const customersIn = Array.isArray(req.body?.customers) ? req.body.customers : [];
    const couponsIn = Array.isArray(req.body?.coupons) ? req.body.coupons : [];

    const result = {
      users: { created: 0, skipped: 0 },
      products: { created: 0, skipped: 0 },
      customers: { created: 0, skipped: 0 },
      coupons: { created: 0, skipped: 0 }
    };

    const seenUsernames = new Set();
    const seenEmails = new Set();
    for (const row of usersIn) {
      const username = String(row?.username || '')
        .toLowerCase()
        .trim();
      const email = String(row?.email || '')
        .toLowerCase()
        .trim();
      const fullName = String(row?.fullName || '').trim();
      const role = String(row?.role || '').toLowerCase() === 'admin' ? 'admin' : 'manager';
      const password = String(row?.password || DEMO_PASSWORD);

      if (!username || !email || fullName.length < 2) {
        result.users.skipped += 1;
        continue;
      }
      if (seenUsernames.has(username) || seenEmails.has(email)) {
        result.users.skipped += 1;
        continue;
      }

      const existing = await User.findOne({
        $or: [{ username }, { email }]
      });
      if (existing) {
        result.users.skipped += 1;
        continue;
      }

      try {
        await User.create({
          fullName,
          username,
          email,
          password,
          role,
          isSuperAdmin: false,
          staffStatus: 'active',
          loginStatus: 'active',
          accountStatus: 'active',
          accountNumber: null,
          balance: 0,
          avatar: {
            style: 'slate',
            initials: fullName
              .split(/\s+/)
              .map((p) => p[0])
              .join('')
              .slice(0, 2)
              .toUpperCase(),
            image: null
          }
        });
        seenUsernames.add(username);
        seenEmails.add(email);
        result.users.created += 1;
      } catch (err) {
        console.warn('Demo user commit skip:', err?.message || err);
        result.users.skipped += 1;
      }
    }

    const seenSkus = new Set();
    for (const row of productsIn) {
      const name = String(row?.name || '').trim();
      const sku = String(row?.sku || '').trim();
      const price = Number(row?.price);
      const stock = Number(row?.stock ?? 0);
      const gstPercentage = Number(row?.gstPercentage ?? 18);
      const category = String(row?.category || '').trim().slice(0, 60);
      const active = row?.active !== false;

      if (!name || Number.isNaN(price) || price < 0 || Number.isNaN(stock) || stock < 0) {
        result.products.skipped += 1;
        continue;
      }
      const skuKey = sku.toLowerCase();
      if (skuKey && seenSkus.has(skuKey)) {
        result.products.skipped += 1;
        continue;
      }
      if (skuKey) {
        const existing = await BillingProduct.findOne({
          sku: new RegExp(`^${sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
        });
        if (existing) {
          result.products.skipped += 1;
          continue;
        }
      }

      try {
        await BillingProduct.create({
          name,
          sku,
          price,
          stock,
          gstPercentage: Number.isNaN(gstPercentage) ? 18 : Math.min(100, Math.max(0, gstPercentage)),
          category,
          active,
          createdBy: req.user._id
        });
        if (skuKey) seenSkus.add(skuKey);
        result.products.created += 1;
      } catch (err) {
        console.warn('Demo product commit skip:', err?.message || err);
        result.products.skipped += 1;
      }
    }

    const seenCustomerEmails = new Set();
    for (const row of customersIn) {
      const name = String(row?.name || '').trim();
      const email = String(row?.email || '')
        .toLowerCase()
        .trim();
      const phone = String(row?.phone || '').trim().slice(0, 32);
      const address = String(row?.address || '').trim().slice(0, 240);
      const bankingAccountNumber = row?.bankingAccountNumber
        ? String(row.bankingAccountNumber).trim().slice(0, 32)
        : null;
      const rewardPoints = Math.max(0, Number(row?.rewardPoints) || 0);

      if (!name) {
        result.customers.skipped += 1;
        continue;
      }
      if (email && seenCustomerEmails.has(email)) {
        result.customers.skipped += 1;
        continue;
      }
      if (email) {
        const existing = await BillingCustomer.findOne({ email });
        if (existing) {
          result.customers.skipped += 1;
          continue;
        }
      }

      try {
        await BillingCustomer.create({
          name,
          email,
          phone,
          address,
          bankingAccountNumber: bankingAccountNumber || null,
          rewardPoints,
          createdBy: req.user._id
        });
        if (email) seenCustomerEmails.add(email);
        result.customers.created += 1;
      } catch (err) {
        console.warn('Demo customer commit skip:', err?.message || err);
        result.customers.skipped += 1;
      }
    }

    const seenCodes = new Set();
    for (const row of couponsIn) {
      const code = String(row?.code || '')
        .toUpperCase()
        .trim();
      const title = String(row?.title || '').trim().slice(0, 80);
      const kind = COUPON_KINDS.includes(String(row?.kind || '').toLowerCase())
        ? String(row.kind).toLowerCase()
        : 'general';
      const discountType = DISCOUNT_TYPES.includes(String(row?.discountType || '').toLowerCase())
        ? String(row.discountType).toLowerCase()
        : 'percent';
      const value = Number(row?.value);
      const usageNote = String(row?.usageNote || 'Demo coupon').trim().slice(0, 220);
      const minSubtotal = Math.max(0, Number(row?.minSubtotal) || 0);
      const active = row?.active !== false;
      let paymentScopes = Array.isArray(row?.paymentScopes)
        ? row.paymentScopes.map((s) => String(s).toLowerCase()).filter((s) => PAYMENT_SCOPES.includes(s))
        : ['any'];
      if (!paymentScopes.length) paymentScopes = ['any'];

      if (!code || !title || Number.isNaN(value) || value < 0) {
        result.coupons.skipped += 1;
        continue;
      }
      if (discountType === 'percent' && value > 100) {
        result.coupons.skipped += 1;
        continue;
      }
      if (seenCodes.has(code)) {
        result.coupons.skipped += 1;
        continue;
      }
      const existing = await BillingCoupon.findOne({ code });
      if (existing) {
        result.coupons.skipped += 1;
        continue;
      }

      try {
        await BillingCoupon.create({
          code,
          title,
          kind,
          discountType,
          value,
          paymentScopes,
          usageNote: usageNote || 'Demo coupon',
          minSubtotal,
          active,
          createdBy: req.user._id,
          updatedBy: req.user._id
        });
        seenCodes.add(code);
        result.coupons.created += 1;
      } catch (err) {
        console.warn('Demo coupon commit skip:', err?.message || err);
        result.coupons.skipped += 1;
      }
    }

    return res.json({
      message: 'Demo data commit finished.',
      ...result
    });
  } catch (error) {
    console.error('Demo commit error:', error);
    return res.status(500).json({ message: 'Unable to commit demo data' });
  }
});

module.exports = router;
