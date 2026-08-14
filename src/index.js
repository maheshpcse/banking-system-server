require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { connectDB } = require('./config/db');
const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/account');
const transactionRoutes = require('./routes/transactions');

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
app.use(express.json());
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

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

async function bootstrap() {
  try {
    await connectDB();
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
