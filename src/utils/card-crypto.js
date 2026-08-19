/**
 * At-rest protection for PAN / CVV.
 * - AES-256-GCM encryption for storage + authorized decrypt on API responses
 * - HMAC hashes for uniqueness lookups (never compare ciphertext)
 *
 * Set CARD_ENCRYPTION_KEY (and optionally CARD_HMAC_KEY) in production.
 * Falls back to JWT_SECRET-derived keys for local demos — not production-grade.
 */
const crypto = require('crypto');
const { normalizeCardNumber } = require('./helpers');

const ENC_PREFIX = 'enc:v1';

function materializeKey(envName, salt) {
  const raw =
    process.env[envName] ||
    process.env.CARD_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    'dev-insecure-card-key';
  return crypto.createHash('sha256').update(`${salt}:${raw}`).digest();
}

function encryptionKey() {
  return materializeKey('CARD_ENCRYPTION_KEY', 'novabank-card-enc');
}

function hmacKey() {
  return materializeKey('CARD_HMAC_KEY', 'novabank-card-hmac');
}

function isEncrypted(value) {
  return String(value || '').startsWith(`${ENC_PREFIX}:`);
}

function encryptSecret(plain) {
  const text = String(plain || '');
  if (!text) {
    return '';
  }
  if (isEncrypted(text)) {
    return text;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(value) {
  const raw = String(value || '');
  if (!raw) {
    return '';
  }
  if (!isEncrypted(raw)) {
    return raw;
  }
  const parts = raw.split(':');
  // enc:v1:iv:tag:data
  if (parts.length < 5) {
    return '';
  }
  const iv = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  const data = Buffer.from(parts.slice(4).join(':'), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function hashCardNumber(number) {
  const clean = normalizeCardNumber(number);
  if (!clean) {
    return null;
  }
  return crypto.createHmac('sha256', hmacKey()).update(`pan:${clean}`).digest('hex');
}

function hashCardCombo(number, cvv) {
  const cleanNumber = normalizeCardNumber(number);
  const cleanCvv = String(cvv || '').replace(/\D/g, '');
  if (!cleanNumber || !cleanCvv) {
    return null;
  }
  return crypto
    .createHmac('sha256', hmacKey())
    .update(`combo:${cleanNumber}|${cleanCvv}`)
    .digest('hex');
}

/**
 * Normalize card secrets for persistence: encrypt PAN/CVV and attach hashes.
 * Accepts plaintext or already-encrypted values.
 */
function sealCardSecrets(card) {
  if (!card) {
    return card;
  }
  const plainNumber = decryptSecret(card.number);
  const plainCvv = decryptSecret(card.cvv);
  const cleanNumber = normalizeCardNumber(plainNumber);
  const cleanCvv = String(plainCvv || '').replace(/\D/g, '');
  return {
    ...card,
    number: cleanNumber ? encryptSecret(cleanNumber) : card.number,
    cvv: cleanCvv ? encryptSecret(cleanCvv) : card.cvv,
    numberHash: cleanNumber ? hashCardNumber(cleanNumber) : card.numberHash || null,
    comboHash: cleanNumber && cleanCvv ? hashCardCombo(cleanNumber, cleanCvv) : card.comboHash || null
  };
}

function revealCardSecrets(card) {
  if (!card) {
    return null;
  }
  return {
    ...card,
    number: decryptSecret(card.number),
    cvv: decryptSecret(card.cvv)
  };
}

module.exports = {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  hashCardNumber,
  hashCardCombo,
  sealCardSecrets,
  revealCardSecrets
};
