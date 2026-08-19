/**
 * Shared helpers for banking-system-server (copy into server utils/).
 */

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function generateReference(prefix) {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, '0');
  return `${prefix}-${stamp}-${rand}`;
}

function generateAccountNumber() {
  const digits = String(Math.floor(100000000000 + Math.random() * 899999999999));
  return `MB${digits}`;
}

/** YY + MM → end of that month; must be current month or future */
function isExpiryCurrentOrFuture(month, year) {
  const mm = String(month || '');
  const yy = String(year || '');
  if (!/^(0[1-9]|1[0-2])$/.test(mm) || !/^[0-9]{2}$/.test(yy)) {
    return false;
  }
  const now = new Date();
  const expEnd = new Date(2000 + Number(yy), Number(mm), 0, 23, 59, 59, 999);
  return expEnd.getTime() >= now.getTime();
}

function normalizeCardNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

module.exports = {
  roundMoney,
  generateReference,
  generateAccountNumber,
  isExpiryCurrentOrFuture,
  normalizeCardNumber
};
