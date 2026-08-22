#!/usr/bin/env node
/**
 * Optional CLI seed for Billing catalog.
 * Prefer POST /api/billing/seed while signed in as manager.
 */
require('dotenv').config();
const { connectDB } = require('../db');
const BillingProduct = require('../../models/BillingProduct');
const BillingCustomer = require('../../models/BillingCustomer');

async function main() {
  await connectDB();
  const products = await BillingProduct.countDocuments();
  const customers = await BillingCustomer.countDocuments();
  if (products > 0 && customers > 0) {
    console.log(`Already seeded (${products} products, ${customers} customers). Pass FORCE=1 to add more.`);
    if (process.env.FORCE !== '1') {
      process.exit(0);
    }
  }

  await BillingProduct.insertMany([
    { name: 'Premium Vault Ledger Kit', sku: 'NV-LED-01', price: 49.0, stock: 40, gstPercentage: 18 },
    { name: 'NovaDesk POS Scanner', sku: 'NV-POS-02', price: 129.5, stock: 18, gstPercentage: 18 },
    { name: 'Secure Card Sleeve Pack', sku: 'NV-CRD-03', price: 14.99, stock: 120, gstPercentage: 5 },
    { name: 'Business Statement Bundle', sku: 'NV-STM-04', price: 29.0, stock: 60, gstPercentage: 12 },
    { name: 'Treasury Insight Report', sku: 'NV-RPT-05', price: 79.0, stock: 25, gstPercentage: 18 }
  ]);
  await BillingCustomer.insertMany([
    {
      name: 'Aurora Trading Co.',
      email: 'accounts@aurora.example',
      phone: '5551002000',
      address: '120 Market Street'
    },
    {
      name: 'Cedar Retail Group',
      email: 'billing@cedar.example',
      phone: '5551003000',
      address: '88 Harbor Lane'
    },
    {
      name: 'Summit Advisory LLC',
      email: 'finance@summit.example',
      phone: '5551004000',
      address: '14 Ridge Avenue'
    }
  ]);
  console.log('Billing sample catalog seeded.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
