// Integration test of the manko.fun / javclick.com logged-in chat (/web/conversations...): same
// account DB as the app (requireUser), but always the product-code-only bot, stored apart from the
// app's real conversations/messages so it never mixes into a paying member's real chat history.
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const db = require("../src/db");
const auth = require("../src/auth");
const rateLimit = require("../src/rateLimit");
const routes = require("../src/routes");
const { ObjectId } = require("mongoose").Types;

const ORIGINAL = { movies: db.movies, actresses: db.actresses, fetchProfile: null };

function fakeMovies(rows) {
  return () => ({
    indexExists: async () => false,
    find: (filter) => {
      let list = rows.filter((m) => {
        if (filter["actress.person_id"] && !(m.actress || []).some((a) => a.person_id === filter["actress.person_id"])) return false;
        if (filter.category_id && m.category_id !== filter.category_id) return false;
        return true;
      });
      list = [...list].sort((a, b) => b.favorite_count - a.favorite_count);
      const cursor = {
        sort: () => cursor,
        limit: (n) => {
          list = list.slice(0, n);
          return cursor;
        },
        toArray: async () => list,
      };
      return cursor;
    },
  });
}

function fakeActresses(list) {
  return () => ({
    find: () => ({ toArray: async () => list }),
    findOne: async (filter) => list.find((a) => a.person_id === filter.person_id) || null,
  });
}

function setUp({ movies = [], actresses = [] } = {}) {
  db.movies = fakeMovies(movies);
  db.actresses = fakeActresses(actresses);
  auth._setFetchProfile(async (host, token) => (token === "tok-a" ? { email: "a@x.com" } : token === "tok-b" ? { email: "b@x.com" } : null));
}

test.afterEach(() => {
  db.movies = ORIGINAL.movies;
  db.actresses = ORIGINAL.actresses;
  auth._setFetchProfile(null);
  rateLimit._reset();
});

// In-memory web_conversations / web_messages, shaped like the real collections closely enough for
// the routes under test (findOne/find/updateOne/insertMany/deleteMany/deleteOne).
function fakeConvCollection() {
  const rows = new Map();
  return {
    rows,
    collection: () => ({
      findOne: async (filter) => {
        for (const c of rows.values()) {
          if (filter._id && String(filter._id) !== String(c._id)) continue;
          if (filter.user && filter.user !== c.user) continue;
          if (filter.person_id && filter.person_id !== c.person_id) continue;
          return c;
        }
        return null;
      },
      find: (filter) => ({
        sort: () => ({
          limit: () => ({
            toArray: async () => [...rows.values()].filter((c) => !filter.user || c.user === filter.user).sort((a, b) => b.last_message_at - a.last_message_at),
          }),
        }),
      }),
      updateOne: async (filter, update) => {
        let c;
        if (filter._id) {
          c = rows.get(String(filter._id));
        } else {
          c = [...rows.values()].find((row) => row.user === filter.user && row.person_id === filter.person_id);
          if (!c) {
            c = { _id: String(new ObjectId()), user: filter.user, person_id: filter.person_id, ...(update.$setOnInsert || {}) };
            rows.set(c._id, c);
          }
        }
        if (!c) return;
        Object.assign(c, update.$set || {});
        for (const [k, v] of Object.entries(update.$inc || {})) c[k] = (c[k] || 0) + v;
      },
      deleteOne: async (filter) => rows.delete(String(filter._id)),
    }),
  };
}

function fakeMsgCollection() {
  const rows = [];
  return {
    rows,
    collection: () => ({
      insertMany: async (docs) => {
        const insertedIds = docs.map(() => String(new ObjectId()));
        docs.forEach((d, i) => rows.push({ ...d, _id: insertedIds[i] }));
        return { insertedIds };
      },
      find: (filter) => ({
        sort: () => ({
          // real Mongo: sort({_id:-1}) then limit -> newest first; routes.js reverses it back to
          // ascending, so this fake must also hand back newest-first for that reverse to be correct
          limit: (n) => ({
            toArray: async () =>
              rows
                .filter((m) => String(m.conversation_id) === String(filter.conversation_id))
                .slice()
                .reverse()
                .slice(0, n),
          }),
        }),
      }),
      deleteMany: async (filter) => {
        for (let i = rows.length - 1; i >= 0; i--) if (String(rows[i].conversation_id) === String(filter.conversation_id)) rows.splice(i, 1);
      },
    }),
  };
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use("/chat-ai", routes);
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}/chat-ai`);
  } finally {
    server.close();
  }
}

const asA = (url, method, path, body) =>
  fetch(`${url}${path}`, {
    method,
    headers: { Authorization: "Bearer tok-a", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
const asB = (url, method, path, body) =>
  fetch(`${url}${path}`, {
    method,
    headers: { Authorization: "Bearer tok-b", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

test("POST /web/conversations needs login", async () => {
  setUp();
  await withServer(async (url) => {
    const r = await fetch(`${url}/web/conversations`, { method: "GET" });
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(await r.json(), { error: "LOGIN_REQUIRED" });
  });
});

test("a rejected/bad token still carries the CORS header on the 401 — otherwise the browser hides the response and the caller only ever sees an opaque network failure", async () => {
  setUp();
  await withServer(async (url) => {
    const r = await fetch(`${url}/web/conversations`, {
      headers: { Authorization: "Bearer bad-token", Origin: "https://manko.fun" },
    });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.headers.get("access-control-allow-origin"), "https://manko.fun");
  });
});

test("preflight OPTIONS is answered before requireUser (no Authorization needed)", async () => {
  setUp();
  await withServer(async (url) => {
    const r = await fetch(`${url}/web/conversations`, { method: "OPTIONS", headers: { Origin: "https://manko.fun" } });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers.get("access-control-allow-origin"), "https://manko.fun");
    assert.ok(r.headers.get("access-control-allow-methods").includes("POST"));
  });
});

test("get-or-create: unknown person_id is NO_PROFILE; a real one returns her display name/avatar", async () => {
  const web = fakeConvCollection();
  db.webConversations = web.collection;
  setUp({ actresses: [{ person_id: "p1", name: "Test", also_known_as: { ko: "테스트" }, avatar: "" }] });
  await withServer(async (url) => {
    const bad = await asA(url, "POST", "/web/conversations", { person_id: "does-not-exist" });
    assert.strictEqual(bad.status, 409);
    assert.deepStrictEqual(await bad.json(), { error: "NO_PROFILE" });

    const ok = await asA(url, "POST", "/web/conversations", { person_id: "p1" });
    assert.strictEqual(ok.status, 200);
    const conv = (await ok.json()).conversation;
    assert.strictEqual(conv.person_id, "p1");
    assert.strictEqual(conv.actor.names.ko, "테스트");

    const again = await asA(url, "POST", "/web/conversations", { person_id: "p1" });
    assert.strictEqual((await again.json()).conversation.id, conv.id, "get-or-create: same conversation, not a new one");
  });
});

test("GET /web/conversations lists only the caller's own conversations", async () => {
  const web = fakeConvCollection();
  db.webConversations = web.collection;
  setUp({ actresses: [{ person_id: "p1", name: "P1", avatar: "" }] });
  await withServer(async (url) => {
    await asA(url, "POST", "/web/conversations", { person_id: "p1" });
    await asB(url, "POST", "/web/conversations", { person_id: "p1" });

    const listA = await (await asA(url, "GET", "/web/conversations")).json();
    assert.strictEqual(listA.conversations.length, 1);
    const listB = await (await asB(url, "GET", "/web/conversations")).json();
    assert.strictEqual(listB.conversations.length, 1);
  });
});

test("sending a message never touches the model: a product-code request answers from the catalogue", async () => {
  const web = fakeConvCollection();
  const msg = fakeMsgCollection();
  db.webConversations = web.collection;
  db.webMessages = msg.collection;
  setUp({
    actresses: [{ person_id: "p1", name: "P1", avatar: "" }],
    movies: [{ _id: "m1", title: "MVSD-1", favorite_count: 9, category_id: "cat", share_date: "2024-01-01", actress: [] }],
  });
  await withServer(async (url) => {
    const conv = (await (await asA(url, "POST", "/web/conversations", { person_id: "p1" })).json()).conversation;
    const r = await asA(url, "POST", `/web/conversations/${conv.id}/messages`, { text: "품번 추천", lang: "ko" });
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.ok(body.reply.content.includes("MVSD-1"));

    const history = await (await asA(url, "GET", `/web/conversations/${conv.id}/messages`)).json();
    assert.strictEqual(history.messages.length, 2);
    assert.strictEqual(history.messages[0].role, "user");
    assert.strictEqual(history.messages[1].role, "assistant");
  });
});

test("own titles: seen codes persist on the conversation so a repeat ask never re-shows the same code", async () => {
  const web = fakeConvCollection();
  const msg = fakeMsgCollection();
  db.webConversations = web.collection;
  db.webMessages = msg.collection;
  setUp({
    actresses: [{ person_id: "p1", name: "P1", avatar: "" }],
    movies: [
      { _id: "m1", title: "ABC-1", favorite_count: 9, actress: [{ person_id: "p1" }], is_active: 1, share_date: "2024-01-01" },
      { _id: "m2", title: "ABC-2", favorite_count: 8, actress: [{ person_id: "p1" }], is_active: 1, share_date: "2024-01-01" },
    ],
  });
  await withServer(async (url) => {
    const conv = (await (await asA(url, "POST", "/web/conversations", { person_id: "p1" })).json()).conversation;
    const first = await (await asA(url, "POST", `/web/conversations/${conv.id}/messages`, { text: "너 출연작 알려줘", lang: "ko" })).json();
    assert.ok(first.reply.content.includes("ABC-1") && first.reply.content.includes("ABC-2"));

    const stored = await web.collection().findOne({ _id: conv.id });
    assert.deepStrictEqual(new Set(stored.seen), new Set(["av:abc1", "av:abc2"]));
  });
});

test("category list pagination: the cursor for one list never leaks into a different list", async () => {
  const web = fakeConvCollection();
  const msg = fakeMsgCollection();
  db.webConversations = web.collection;
  db.webMessages = msg.collection;
  setUp({
    actresses: [{ person_id: "p1", name: "P1", avatar: "" }],
    movies: [{ _id: "m1", title: "MVSD-1", favorite_count: 9, category_id: "cat", share_date: "2024-01-01", actress: [] }],
  });
  await withServer(async (url) => {
    const conv = (await (await asA(url, "POST", "/web/conversations", { person_id: "p1" })).json()).conversation;
    await asA(url, "POST", `/web/conversations/${conv.id}/messages`, { text: "품번 추천", lang: "ko" });
    const stored = await web.collection().findOne({ _id: conv.id });
    assert.ok(stored.cursors && stored.cursors.all, "the 'all' list's cursor was saved under its own key");
  });
});

test("a conversation belongs to its owner only: another account gets 404, not someone else's chat", async () => {
  const web = fakeConvCollection();
  db.webConversations = web.collection;
  setUp({ actresses: [{ person_id: "p1", name: "P1", avatar: "" }] });
  await withServer(async (url) => {
    const conv = (await (await asA(url, "POST", "/web/conversations", { person_id: "p1" })).json()).conversation;
    const r = await asB(url, "GET", `/web/conversations/${conv.id}/messages`);
    assert.strictEqual(r.status, 404);
  });
});

test("DELETE removes the conversation and its messages", async () => {
  const web = fakeConvCollection();
  const msg = fakeMsgCollection();
  db.webConversations = web.collection;
  db.webMessages = msg.collection;
  setUp({ actresses: [{ person_id: "p1", name: "P1", avatar: "" }] });
  await withServer(async (url) => {
    const conv = (await (await asA(url, "POST", "/web/conversations", { person_id: "p1" })).json()).conversation;
    const del = await asA(url, "DELETE", `/web/conversations/${conv.id}`);
    assert.strictEqual(del.status, 200);
    const after = await asA(url, "GET", `/web/conversations/${conv.id}/messages`);
    assert.strictEqual(after.status, 404);
  });
});

test("sending is rate-limited (10/minute), same as the anonymous product-code path", async () => {
  const web = fakeConvCollection();
  const msg = fakeMsgCollection();
  db.webConversations = web.collection;
  db.webMessages = msg.collection;
  setUp({
    actresses: [{ person_id: "p1", name: "P1", avatar: "" }],
    movies: [{ _id: "m1", title: "MVSD-1", favorite_count: 9, category_id: "cat", share_date: "2024-01-01", actress: [] }],
  });
  await withServer(async (url) => {
    const conv = (await (await asA(url, "POST", "/web/conversations", { person_id: "p1" })).json()).conversation;
    let last;
    for (let i = 0; i < 11; i++) last = await asA(url, "POST", `/web/conversations/${conv.id}/messages`, { text: "hi", lang: "en" });
    assert.strictEqual(last.status, 429);
    assert.deepStrictEqual(await last.json(), { error: "RATE_LIMITED" });
  });
});
