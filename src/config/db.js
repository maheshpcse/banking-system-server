const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let memoryServer;

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  const useMemory = process.env.USE_MEMORY_DB !== 'false';

  if (uri && uri.trim() !== '') {
    await mongoose.connect(uri);
    console.log('Connected to MongoDB');
    return;
  }

  if (!useMemory) {
    console.warn('No MongoDB URI configured and in-memory DB is disabled. Continuing without a database connection.');
    return;
  }

  try {
    memoryServer = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' }
    });
    await memoryServer.waitUntilRunning();
    const memoryUri = memoryServer.getUri();
    await mongoose.connect(memoryUri);
    console.log('Connected to in-memory MongoDB replica set (demo mode)');
  } catch (error) {
    console.warn('In-memory MongoDB is unavailable; the app will continue without a database connection. Configure MONGODB_URI for production.', error.message);
    throw error;
  }
}

async function disconnectDB() {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
  }
}

module.exports = { connectDB, disconnectDB };
