const express = require("express");
const { ObjectId } = require("mongoose").Types;
const config = require("./config");
const db = require("./db");
const { requireUser, membershipActive } = require("./auth");
const { getPersona, languageNote } = require("./persona");
const deepseek = require("./deepseek");
const { avatarUrl } = require("./images");

const router = express.Router();

const sending = new Set(); // conversation ids with a model call in flight (one at a time)

const dayKey = () => new Date().toISOString().slice(0, 10);

function toConversation(c, req) {
  return {
    id: String(c._id),
    person_id: c.person_id,
    actor: { names: c.actor_names || {}, avatar: avatarUrl(c.actor_avatar, req.headers.host) },
    last_message: c.last_message || "",
    last_message_at: c.last_message_at || c.created_at,
    message_count: c.message_count || 0,
  };
}

function toMessage(m) {
  return { id: String(m._id), role: m.role, content: m.content, created_at: m.created_at };
}

function parseId(value) {
  return typeof value === "string" && ObjectId.isValid(value) ? new ObjectId(value) : null;
}

async function ownConversation(req, res) {
  const id = parseId(req.params.id);
  const conv = id && (await db.conversations().findOne({ _id: id, user: req.user.email }));
  if (!conv) {
    res.status(404).json({ error: "NOT_FOUND" });
    return null;
  }
  return conv;
}

router.get("/health", (req, res) => res.json({ ok: true }));

router.use(requireUser);

// Chat button: can this actress be chatted with, does the user have an active membership,
// and is there already a conversation? The app decides chat screen vs. subscribe popup from this.
router.get("/actress/:personId/status", async (req, res, next) => {
  try {
    const persona = await getPersona(req.params.personId);
    const conv = await db.conversations().findOne({ user: req.user.email, person_id: req.params.personId });
    res.json({
      chattable: !!persona,
      membership_active: await membershipActive(req),
      conversation_id: conv ? String(conv._id) : null,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/conversations", async (req, res, next) => {
  try {
    const list = await db
      .conversations()
      .find({ user: req.user.email })
      .sort({ last_message_at: -1 })
      .limit(100)
      .toArray();
    res.json({ conversations: list.map((c) => toConversation(c, req)) });
  } catch (error) {
    next(error);
  }
});

// Get-or-create the single conversation between this user and this actress.
router.post("/conversations", async (req, res, next) => {
  try {
    if (!(await membershipActive(req))) return res.status(403).json({ error: "MEMBERSHIP_REQUIRED" });

    const personId = req.body && req.body.person_id;
    const persona = await getPersona(personId);
    if (!persona) return res.status(409).json({ error: "NO_PROFILE" });

    const now = new Date();
    await db.conversations().updateOne(
      { user: req.user.email, person_id: personId },
      {
        $setOnInsert: { created_at: now, last_message_at: now, message_count: 0, last_message: "" },
        $set: { actor_names: persona.displayNames, actor_avatar: persona.avatar },
      },
      { upsert: true }
    );
    const conv = await db.conversations().findOne({ user: req.user.email, person_id: personId });
    res.json({ conversation: toConversation(conv, req) });
  } catch (error) {
    next(error);
  }
});

router.get("/conversations/:id/messages", async (req, res, next) => {
  try {
    const conv = await ownConversation(req, res);
    if (!conv) return;

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const filter = { conversation_id: conv._id };
    const before = parseId(req.query.before);
    if (before) filter._id = { $lt: before };

    const rows = await db.messages().find(filter).sort({ _id: -1 }).limit(limit).toArray();
    res.json({ messages: rows.reverse().map(toMessage), has_more: rows.length === limit });
  } catch (error) {
    next(error);
  }
});

router.post("/conversations/:id/messages", async (req, res, next) => {
  let convId = null;
  let locked = false;
  let charged = false;
  let modelCalled = false;
  try {
    const conv = await ownConversation(req, res);
    if (!conv) return;

    const text = req.body && typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "EMPTY_MESSAGE" });
    if (text.length > config.maxInputChars) return res.status(400).json({ error: "MESSAGE_TOO_LONG" });

    if (!(await membershipActive(req))) return res.status(403).json({ error: "MEMBERSHIP_REQUIRED" });

    convId = String(conv._id);
    if (sending.has(convId)) return res.status(429).json({ error: "BUSY" });

    const persona = await getPersona(conv.person_id);
    if (!persona) return res.status(409).json({ error: "NO_PROFILE" });

    // Daily cap per user; counted before the model call so parallel requests can't slip past.
    const usage = await db.usage().findOneAndUpdate(
      { user: req.user.email, day: dayKey() },
      { $inc: { count: 1 }, $setOnInsert: { created_at: new Date() } },
      { upsert: true, returnDocument: "after" }
    );
    charged = true;
    if (usage.value.count > config.dailyMessageLimit) {
      return res.status(429).json({ error: "DAILY_LIMIT", limit: config.dailyMessageLimit });
    }

    sending.add(convId);
    locked = true;
    const recent = await db
      .messages()
      .find({ conversation_id: conv._id })
      .sort({ _id: -1 })
      .limit(config.historyMessages)
      .toArray();
    recent.reverse();

    modelCalled = true;
    const result = await deepseek.chat([
      { role: "system", content: persona.systemPrompt },
      { role: "system", content: languageNote(req.body.lang) },
      ...recent.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: text },
    ]);

    const now = new Date();
    const inserted = await db.messages().insertMany([
      { conversation_id: conv._id, role: "user", content: text, created_at: now },
      { conversation_id: conv._id, role: "assistant", content: result.text, created_at: new Date(now.getTime() + 1) },
    ]);
    await db.conversations().updateOne(
      { _id: conv._id },
      {
        $set: { last_message: result.text.slice(0, 200), last_message_at: new Date(), actor_names: persona.displayNames, actor_avatar: persona.avatar },
        $inc: { message_count: 2 },
      }
    );
    charged = false; // succeeded: the count stands

    res.json({
      user_message: toMessage({ _id: inserted.insertedIds[0], role: "user", content: text, created_at: now }),
      reply: toMessage({ _id: inserted.insertedIds[1], role: "assistant", content: result.text, created_at: now }),
    });
  } catch (error) {
    // Give the message back only if DeepSeek surely didn't bill it: we never called it, or it
    // answered with an HTTP error. A timeout or an empty reply was still paid for, so it keeps
    // counting toward the daily cap (otherwise retries after failures would be unlimited).
    if (charged && (!modelCalled || error.response)) {
      db.usage().updateOne({ user: req.user.email, day: dayKey() }, { $inc: { count: -1 } }).catch(() => {});
    }
    console.log("[send] failed:", error.message);
    if (!res.headersSent) {
      res.status(502).json({ error: error.code === "AUTH_UNAVAILABLE" ? "AUTH_UNAVAILABLE" : "MODEL_UNAVAILABLE" });
    }
  } finally {
    if (locked) sending.delete(convId);
  }
});

router.delete("/conversations/:id", async (req, res, next) => {
  try {
    const conv = await ownConversation(req, res);
    if (!conv) return;
    await db.messages().deleteMany({ conversation_id: conv._id });
    await db.conversations().deleteOne({ _id: conv._id });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
