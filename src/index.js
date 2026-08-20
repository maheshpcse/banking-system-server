require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { connectDB } = require('./config/db');
const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/account');
const transactionRoutes = require('./routes/transactions');
const notificationRoutes = require('./routes/notifications');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = (process.env.CLIENT_ORIGIN || 'http://localhost:4200')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      // Allow local Angular hosts during development.
      const localDev = [
        'http://localhost:4200',
        'http://127.0.0.1:4200',
        'http://0.0.0.0:4200'
      ];

      if (!origin || allowed.includes(origin) || localDev.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'minimal-banking-api' });
});

app.get('/api/v1/health/live', (_req, res) => {
  res.json({ status: 'ok', service: 'banking-system-server' });
});

app.use('/api/auth', authRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

async function bootstrap() {
  try {
    await connectDB();
    try {
      const { migrateAllUsers } = require('./services/user-domain');
      const result = await migrateAllUsers();
      console.log(
        `[domain-migrate] synced ${result.migrated}/${result.total} users into accounts/cards/… collections`
      );
    } catch (migrateError) {
      console.warn('[domain-migrate] skipped:', migrateError.message);
    }
  } catch (error) {
    console.warn('Database initialization failed; continuing to start the API for health checks.', error.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Banking API listening on http://localhost:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
