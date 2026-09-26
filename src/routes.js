const express = require("express");
const { ObjectId } = require("mongoose").Types;
const config = require("./config");
const db = require("./db");
const { requireUser, membershipActive } = require("./auth");
const { getPersona, promptFor, prewarmCard, languageNote } = require("./persona");
const { trimToLastSentence } = require("./text");
const deepseek = require("./deepseek");
const lookupGuard = require("./lookupGuard");
const productList = require("./productList");
const { toolDefsFor, runTool } = require("./tools");
const humor = require("./humor");
const linkGuard = require("./linkGuard");
const { avatarUrl } = require("./images");
const titleLinks = require("./titleLinks");
const verifiedFacts = require("./verifiedFacts");

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
  const out = { id: String(m._id), role: m.role, content: m.content, created_at: m.created_at };
  if (Array.isArray(m.links) && m.links.length) out.links = m.links;
  return out;
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

    prewarmCard(persona); // make her character card while the user is still opening the chat

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

    // "품번" (product code) request: a fixed template + the next titles of User's Pick, no model call.
    // These two messages are flagged `template` and left out of what the model sees later.
    if (productList.wantsProductList(text)) {
      const out = await productList.buildReply(conv, String(req.body.lang || "en").toLowerCase());
      const at = new Date();
      const saved = await db.messages().insertMany([
        { conversation_id: conv._id, role: "user", content: text, created_at: at, template: true },
        { conversation_id: conv._id, role: "assistant", content: out.text, created_at: new Date(at.getTime() + 1), template: true, ...(out.links.length ? { links: out.links } : {}) },
      ]);
      await db.conversations().updateOne(
        { _id: conv._id },
        {
          $set: {
            last_message: out.text.slice(0, 200),
            last_message_at: new Date(),
            actor_names: persona.displayNames,
            actor_avatar: persona.avatar,
            // shown titles are remembered so the next request continues with new ones; when the list
            // ran out and started over, the list starts over too
            ...(out.reset ? { recommended_movies: out.ids } : {}),
          },
          $inc: { message_count: 2 },
          ...(out.ids.length && !out.reset ? { $push: { recommended_movies: { $each: out.ids } } } : {}),
        }
      );
      charged = false; // succeeded: the count stands
      return res.json({
        user_message: toMessage({ _id: saved.insertedIds[0], role: "user", content: text, created_at: at }),
        reply: toMessage({ _id: saved.insertedIds[1], role: "assistant", content: out.text, created_at: at, links: out.links }),
      });
    }
    const recent = await db
      .messages()
      .find({ conversation_id: conv._id })
      .sort({ _id: -1 })
      .limit(config.historyMessages)
      .toArray();
    recent.reverse();

    modelCalled = true;
    const lang = req.body.lang;
    // links already sent in this conversation are never sent again; `picked` collects the one
    // the model chose this turn (the server, not the model, writes the address)
    const context = {
      lang: String(lang || "en").toLowerCase(),
      country: req.headers["cf-ipcountry"],
      sharedUrls: new Set(conv.shared_urls || []),
      picked: [],
      knownTitles: [], // titles the tools returned this turn (their type helps the app open the right page)
      recommended: new Set(conv.recommended_titles || []), // "movie:123" keys: never recommended again here
    };
    // conversations from before `recommended_titles` existed: what the recent replies linked counts too
    for (const m of recent) {
      for (const l of m.links || []) if (l.tmdb_id && l.type) context.recommended.add(`${l.type}:${l.tmdb_id}`);
    }
    // Clear "something funny" requests (and "another one" right after a link) are handled by the
    // server: it picks the post and tells the model exactly what to say, or that there is none.
    // Left to the model it made up posts without calling the tool.
    let funnySystem = null;
    if (humor.isEligible(lang)) {
      const lastAssistant = [...recent].reverse().find((m) => m.role === "assistant");
      const afterLink = Boolean(lastAssistant && linkGuard.LINK_BLOCK_RE.test(lastAssistant.content));
      if (humor.wantsFunnyPost(text, { afterLink })) {
        const pick = await humor.pickForContext(context);
        funnySystem = humor.funnyNote(pick.error ? null : context.picked[0]);
      }
    }
    const factsText = await verifiedFacts.getFacts(conv.person_id).catch(() => null);
    const messages = [
      { role: "system", content: await promptFor(persona) },
      { role: "system", content: languageNote(lang) + (humor.isEligible(lang) ? " " + humor.FUNNY_HINT : "") },
      ...(funnySystem ? [{ role: "system", content: funnySystem }] : []),
      ...recent.filter((m) => !m.template).map((m) => ({
        role: m.role,
        content: m.role === "assistant" ? titleLinks.applyMarkers(linkGuard.stripLinkBlock(m.content), m.links) : titleLinks.stripMarkers(m.content),
      })),
      // earlier refusals in this chat ("I can't talk about that") would otherwise be repeated
      ...(factsText && verifiedFacts.mentionsFacts(text, factsText) ? [{ role: "system", content: verifiedFacts.HISTORY_REMINDER }] : []),
      // ...and the ⟦ ⟧ format is dropped once earlier replies in the chat have none
      { role: "system", content: titleLinks.MARK_REMINDER },
      { role: "user", content: text },
    ];
    let result = await lookupGuard.converseWithLookup(messages, { tools: toolDefsFor(context), runTool, context });
    // A draft that says it found / brought a post while the app has none for this message is a
    // made-up post: have it rewritten once, without tools, and without such claims.
    if (humor.isEligible(lang) && !context.picked.length && humor.claimsPost(result.text)) {
      console.log("[humor] draft claimed a post without a link; rewriting");
      result = await deepseek.converse([...messages, { role: "system", content: humor.NO_CLAIM_NOTE }], {});
    }

    // ran out of tokens mid-sentence: don't show (or store) a half-finished reply
    // nothing link-like the model wrote is trusted (it invents addresses); real links are appended below
    const modelText = linkGuard.stripModelLinks(result.text) || result.text.replace(/https?:\/\/\S+/g, "").trim();
    const trimmedText = result.finishReason === "length" ? trimToLastSentence(modelText) : modelText;
    // ⟦Title⟧ markers become plain text plus positions (`links`); the link block below is appended after them
    const extracted = titleLinks.extractTitleLinks(trimmedText, context.knownTitles);
    let replyText = extracted.text;
    // only titles the tools returned (they carry a TMDB id) become links
    const replyLinks = titleLinks.keepOpenable(extracted.links);
    // what she named this turn is remembered, so the next recommendation is a different one
    const recommendedNow = [...new Set(replyLinks.filter((l) => l.tmdb_id && l.type).map((l) => `${l.type}:${l.tmdb_id}`))];
    const spokenText = replyText; // what she says, without the link block (used for the list preview)
    const sharedPost = context.picked[0] || null; // one link per message
    if (sharedPost) replyText += humor.linkBlock(sharedPost);

    const now = new Date();
    const inserted = await db.messages().insertMany([
      { conversation_id: conv._id, role: "user", content: text, created_at: now },
      {
        conversation_id: conv._id,
        role: "assistant",
        content: replyText,
        created_at: new Date(now.getTime() + 1),
        ...(replyLinks.length ? { links: replyLinks } : {}),
      },
    ]);
    await db.conversations().updateOne(
      { _id: conv._id },
      {
        $set: { last_message: spokenText.slice(0, 200), last_message_at: new Date(), actor_names: persona.displayNames, actor_avatar: persona.avatar },
        $inc: { message_count: 2 },
        ...(sharedPost || recommendedNow.length
          ? {
              $push: {
                ...(sharedPost ? { shared_urls: { $each: [sharedPost.url], $slice: -300 } } : {}),
                ...(recommendedNow.length ? { recommended_titles: { $each: recommendedNow, $slice: -400 } } : {}),
              },
            }
          : {}),
      }
    );
    charged = false; // succeeded: the count stands

    res.json({
      user_message: toMessage({ _id: inserted.insertedIds[0], role: "user", content: text, created_at: now }),
      reply: toMessage({ _id: inserted.insertedIds[1], role: "assistant", content: replyText, created_at: now, links: replyLinks }),
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
