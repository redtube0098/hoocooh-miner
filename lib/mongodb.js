const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "hoocooh_mine";

if (!uri) {
  console.warn("MONGODB_URI is not set - set it in your Vercel project's environment variables.");
}

// Cache the client/db across warm serverless invocations (avoids
// reconnecting to MongoDB on every request).
let cachedClient = global._hoocoohMongoClient;
let cachedDb = global._hoocoohMongoDb;

async function getDb() {
  if (cachedDb) return cachedDb;

  if (!uri) {
    throw new Error("MONGODB_URI is not set in environment variables");
  }

  if (!cachedClient) {
    cachedClient = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    global._hoocoohMongoClient = cachedClient;
  }

  await cachedClient.connect();

  cachedDb = cachedClient.db(dbName);
  global._hoocoohMongoDb = cachedDb;
  return cachedDb;
}

module.exports = { getDb };
