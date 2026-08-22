# NovaBank API (Express + MongoDB)

Backend for the NovaBank minimal banking system (MEAN stack).

Frontend UI: [`maheshpcse/banking-system`](https://github.com/maheshpcse/banking-system)

## Features

- JWT register / login
- Account summary
- Deposit / withdraw
- Peer transfers
- Paginated transaction history
- **Billing APIs** (`/api/billing`) — products, customers, bills, payments, complaints, gateway settings
  - Write ops: Manager / Admin only (not Super Admin)
  - Read/monitor: Manager / Admin / Super Admin
- In-memory MongoDB replica set for local demo (or real `MONGODB_URI`)

## Requirements

- Node.js **16.20+**
- npm 8+

## Quick start

```bash
cp .env.example .env
npm install
npm start
```

API: [http://localhost:3000](http://localhost:3000)  
Health: [http://localhost:3000/api/health](http://localhost:3000/api/health)

> On Ubuntu 24.04+, `npm start` auto-fetches local OpenSSL 1.1 libs so the in-memory MongoDB binary can start.

## Configuration

| Variable | Description |
|---|---|
| `PORT` | API port (default `3000`) |
| `JWT_SECRET` | JWT signing secret |
| `CARD_ENCRYPTION_KEY` | AES key material for PAN/CVV at rest (falls back to `JWT_SECRET` in demos) |
| `CARD_HMAC_KEY` | Optional HMAC key for card uniqueness hashes |
| `USE_MEMORY_DB` | `true` uses embedded MongoDB (default) |
| `MONGODB_URI` | Real MongoDB URI when `USE_MEMORY_DB=false` |
| `CLIENT_ORIGIN` | CORS origin (default `http://localhost:4200`) |

## Card security

- PAN and CVV are **encrypted at rest** (AES-256-GCM) and decrypted only for authorized API responses (`toSafeJSON`).
- Uniqueness of Card Number + CVV uses an HMAC `comboHash` with a sparse unique MongoDB index (closes races beyond app-level `findOne`).
- UI masking alone is **not** encryption — see `src/utils/card-crypto.js`.

## Money controls & limits

- `moneyGate` enforces frozen, onlinePayments, contactless, international, and atmWithdrawals by channel (`online` | `atm` | `contactless` | `international`).
- Deposit / transfer default to `online`; withdraw defaults to `atm`. Optional body `channel` overrides.
- Daily caps use a **rolling 24-hour** window (`sumRolling24h`), not calendar midnight.
- Limit approvals: **Manager** (or **Super Admin** override) via `/api/admin/limit-requests`.

## API overview

- `POST /api/auth/register` · `POST /api/auth/login` · `GET /api/auth/me`
- `POST /api/auth/staff-register` · `POST /api/auth/staff-status`
- `GET /api/account/summary` · `POST /api/account/deposit|withdraw|transfer`
- `PATCH /api/account/card-controls` · `POST /api/account/limits/request`
- `GET /api/admin/limit-requests` · `GET /api/admin/analytics`
- `GET /api/transactions`

## Docker

```bash
docker build -t banking-server .
docker run --rm -p 3000:3000 \
  -e USE_MEMORY_DB=true \
  -e JWT_SECRET=dev-secret \
  -e CARD_ENCRYPTION_KEY=dev-card-key \
  -e CLIENT_ORIGIN=http://localhost:4200 \
  banking-server
```

## Scripts

| Command | Description |
|---|---|
| `npm start` | Start API (`start.sh`) |
| `npm run dev` | Nodemon + `start.sh` |
| `npm run start:raw` | `node src/index.js` without OpenSSL helper |
| `npm run seed:admin` | Seed Super Admin (`src/config/scripts/seed-admin.js`; wrapper also at `scripts/seed-admin.js`) |
| `npm run seed:billing` | Seed sample billing catalog (or use `POST /api/billing/seed`) |
