import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "join_request_bot";

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI env var. Set it to your MongoDB Atlas connection string.");
}

const client = new MongoClient(MONGODB_URI);
let db;

export async function connectDB() {
  if (db) return db;
  await client.connect();
  db = client.db(DB_NAME);

  // helpful indexes
  await db.collection("bots").createIndex({ token: 1 }, { unique: true });
  await db.collection("users").createIndex({ token: 1, userId: 1 }, { unique: true });

  console.log("MongoDB connected:", DB_NAME);
  return db;
}

// ---------- bot config ----------

export async function getBot(token) {
  return db.collection("bots").findOne({ token });
}

export async function ensureBot(token, defaults) {
  const existing = await getBot(token);
  if (existing) return existing;
  const doc = {
    token,
    adminId: String(defaults.adminId),
    channelUsername: defaults.channelUsername || "",
    forwardMessageId: defaults.forwardMessageId || null,
    button1: defaults.button1 || null, // { text, url }
    button2: defaults.button2 || null,
    createdAt: new Date()
  };
  await db.collection("bots").insertOne(doc);
  return doc;
}

export async function updateBot(token, fields) {
  await db.collection("bots").updateOne({ token }, { $set: fields });
}

// ---------- users (per bot, for broadcast) ----------

export async function saveUser(token, userId) {
  await db.collection("users").updateOne(
    { token, userId },
    { $setOnInsert: { token, userId, joinedAt: new Date() } },
    { upsert: true }
  );
}

export async function removeUser(token, userId) {
  await db.collection("users").deleteOne({ token, userId });
}

export async function getUsers(token) {
  const docs = await db.collection("users").find({ token }).toArray();
  return docs.map((d) => d.userId);
}

export async function countUsers(token) {
  return db.collection("users").countDocuments({ token });
}
