const mongoose = require("mongoose");
const config = require("./config");

// Collections written by this service. actress_new is only ever read.
const CONVERSATIONS = "actor_chat_conversations";
const MESSAGES = "actor_chat_messages";
const USAGE = "actor_chat_usage";
const CARDS = "actor_persona_cards";
const HUMOR = "actor_humor_posts";

async function connect() {
  if (!config.mongoUri) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(config.mongoUri, { dbName: config.mongoDb });
  const db = mongoose.connection.db;
  await db.collection(CONVERSATIONS).createIndex({ user: 1, person_id: 1 }, { unique: true });
  await db.collection(CONVERSATIONS).createIndex({ user: 1, last_message_at: -1 });
  await db.collection(MESSAGES).createIndex({ conversation_id: 1, _id: -1 });
  await db.collection(USAGE).createIndex({ user: 1, day: 1 }, { unique: true });
  await db.collection(CARDS).createIndex({ person_id: 1 }, { unique: true });
  await db.collection(HUMOR).createIndex({ source: 1, post_id: 1 }, { unique: true });
  await db.collection(HUMOR).createIndex({ source: 1, post_num: -1 });
  await db.collection(HUMOR).createIndex({ source: 1, first_seen: -1, views: -1 });
  // only recent posts are ever offered
  await db.collection(HUMOR).createIndex({ first_seen: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
  // usage rows are only needed for the current day
  await db.collection(USAGE).createIndex({ created_at: 1 }, { expireAfterSeconds: 3 * 24 * 3600 });
  return db;
}

const col = (name) => mongoose.connection.db.collection(name);

module.exports = {
  connect,
  conversations: () => col(CONVERSATIONS),
  messages: () => col(MESSAGES),
  usage: () => col(USAGE),
  cards: () => col(CARDS),
  humorPosts: () => col(HUMOR),
  actresses: () => col("actress_new"),
};
