const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let memoryServer;

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  const useMemory = process.env.USE_MEMORY_DB !== 'false';

  if (uri && uri.trim() !== '' && !useMemory) {
    await mongoose.connect(uri);
    console.log('Connected to MongoDB');
    return;
  }

  memoryServer = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });
  await memoryServer.waitUntilRunning();
  const memoryUri = memoryServer.getUri();
  await mongoose.connect(memoryUri);
  console.log('Connected to in-memory MongoDB replica set (demo mode)');
}

async function disconnectDB() {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
  }
}

module.exports = { connectDB, disconnectDB };
