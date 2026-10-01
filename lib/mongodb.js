const { MongoClient } = require("mongodb");

let cachedClient = global._hoocoohMongoClient;
let cachedDb = global._hoocoohMongoDb;

async function getDb() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "hoocooh_mine";

  if (!uri) {
    throw new Error("MONGODB_URI is not set in Vercel environment variables");
  }

  if (cachedDb) return cachedDb;

  if (!cachedClient) {
    cachedClient = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
    });
    global._hoocoohMongoClient = cachedClient;
  }

  try {
    await cachedClient.connect();
    cachedDb = cachedClient.db(dbName);
    global._hoocoohMongoDb = cachedDb;
    return cachedDb;
  } catch (err) {
    // If cached client had stale connection, recreate and connect
    console.warn("Re-establishing MongoDB connection...", err.message);
    cachedClient = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
    });
    global._hoocoohMongoClient = cachedClient;
    await cachedClient.connect();
    cachedDb = cachedClient.db(dbName);
    global._hoocoohMongoDb = cachedDb;
    return cachedDb;
  }
}

module.exports = { getDb };
