// Integration-level test of the message-quota tiering in routes.js: lifetime vs time-limited
// membership, product-code requests never charged, and the refund-on-failure path. Every I/O
// dependency (Mongo, the account server, DeepSeek) is replaced the same way productList.test.js
// and auth.test.js already do it: routes.js holds the same module object these tests mutate.
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const config = require("../src/config");
const db = require("../src/db");
const auth = require("../src/auth");
const lookupGuard = require("../src/lookupGuard");
const verifiedFacts = require("../src/verifiedFacts");
const productList = require("../src/productList");
const routes = require("../src/routes");

const ORIGINAL_LIMITS = { daily: config.dailyMessageLimit, monthly: config.monthlyMessageLimit, lifetime: config.lifetimeMessageLimit };
const ORIGINAL = {
  conversations: db.conversations,
  messages: db.messages,
  usage: db.usage,
  usageMonth: db.usageMonth,
  usageLifetime: db.usageLifetime,
  actresses: db.actresses,
  cards: db.cards,
  converseWithLookup: lookupGuard.converseWithLookup,
  getFacts: verifiedFacts.getFacts,
  detectList: productList.detectList,
};
test.afterEach(() => {
  config.dailyMessageLimit = ORIGINAL_LIMITS.daily;
  config.monthlyMessageLimit = ORIGINAL_LIMITS.monthly;
  config.lifetimeMessageLimit = ORIGINAL_LIMITS.lifetime;
  db.conversations = ORIGINAL.conversations;
  db.messages = ORIGINAL.messages;
  db.usage = ORIGINAL.usage;
  db.usageMonth = ORIGINAL.usageMonth;
  db.usageLifetime = ORIGINAL.usageLifetime;
  db.actresses = ORIGINAL.actresses;
  db.cards = ORIGINAL.cards;
  lookupGuard.converseWithLookup = ORIGINAL.converseWithLookup;
  verifiedFacts.getFacts = ORIGINAL.getFacts;
  productList.detectList = ORIGINAL.detectList;
});

const CONV_ID = "605c5f5f5f5f5f5f5f5f5f5f";

// getPersona / promptFor are destructured by routes.js at load time, so they can't be swapped
// from here (the local binding stays the real function) — mock what THEY read from Mongo instead.
// A stored card is what makes promptFor return at once, without a real DeepSeek call.
const FAKE_ACTRESS = {
  person_id: "P1",
  name: "Test",
  also_known_as: { en: "Test Actress" },
  avatar: "",
  spec: {},
  description: [{ language: "ko", overview: "가".repeat(320) }],
  is_active: 1,
};
const FAKE_CARD = { person_id: "P1", card: "Personality: test.", source_hash: "x" };

/** An in-memory counter collection shaped like the real `usage`/`usageMonth`/`usageLifetime` ones. */
function fakeCounter() {
  const rows = new Map();
  return {
    rows,
    collection: () => ({
      findOneAndUpdate: async (filter) => {
        const key = JSON.stringify(filter);
        const next = (rows.get(key) || 0) + 1;
        rows.set(key, next);
        return { value: { count: next } };
      },
      updateOne: async (filter, { $inc }) => {
        const key = JSON.stringify(filter);
        rows.set(key, (rows.get(key) || 0) + $inc.count);
      },
    }),
  };
}

function setUp({ subExpiresAt, daily, monthly, lifetime, converse, detectList, dailyLimit = 15, monthlyLimit = 300, lifetimeLimit = 3600 } = {}) {
  config.dailyMessageLimit = dailyLimit;
  config.monthlyMessageLimit = monthlyLimit;
  config.lifetimeMessageLimit = lifetimeLimit;
  const daily_ = daily || fakeCounter();
  const monthly_ = monthly || fakeCounter();
  const lifetime_ = lifetime || fakeCounter();
  db.conversations = () => ({
    findOne: async () => ({ _id: CONV_ID, user: "u@x.com", person_id: "P1", shared_urls: [], recommended_titles: [] }),
    updateOne: async () => {},
  });
  db.messages = () => ({
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
    insertMany: async (docs) => ({ insertedIds: docs.map((_, i) => `m${i}`) }),
  });
  db.usage = daily_.collection;
  db.usageMonth = monthly_.collection;
  db.usageLifetime = lifetime_.collection;
  db.actresses = () => ({ findOne: async () => FAKE_ACTRESS });
  db.cards = () => ({ findOne: async () => FAKE_CARD });
  verifiedFacts.getFacts = async () => null;
  productList.detectList = detectList || (() => null);
  lookupGuard.converseWithLookup = converse || (async () => ({ text: "hi", finishReason: "stop" }));

  auth._setFetchProfile(async () => ({ email: "u@x.com", sub_expires_at: subExpiresAt }));
  return { daily: daily_, monthly: monthly_, lifetime: lifetime_ };
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use("/chat-ai", routes);
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}/chat-ai/conversations/${CONV_ID}/messages`);
  } finally {
    server.close();
  }
}

const send = (url, text) =>
  fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
    body: JSON.stringify({ text, lang: "en" }),
  });

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const inYears = (n) => Date.now() + n * YEAR_MS;

test("time-limited member: daily cap (15) blocks with DAILY_LIMIT, monthly is untouched by it", async () => {
  setUp({ subExpiresAt: inYears(0.5) }); // a 6-month-ish plan: not lifetime
  await withServer(async (url) => {
    let last;
    for (let i = 0; i < 16; i++) last = await send(url, "hi");
    assert.strictEqual(last.status, 429);
    assert.deepStrictEqual(await last.json(), { error: "DAILY_LIMIT", limit: 15 });
  });
});

test("time-limited member: the monthly cap (300) blocks even while under the daily cap (resets each day)", async () => {
  const monthly = fakeCounter();
  monthly.rows.set(JSON.stringify({ user: "u@x.com", month: new Date().toISOString().slice(0, 7) }), 300);
  setUp({ subExpiresAt: inYears(1), monthly });
  await withServer(async (url) => {
    const r = await send(url, "hi"); // 1st message of a fresh day, but the month is already at 300
    assert.strictEqual(r.status, 429);
    assert.deepStrictEqual(await r.json(), { error: "MONTHLY_LIMIT", limit: 300 });
  });
});

test("lifetime member (>=10 years left): a running total (3600) applies instead of daily/monthly", async () => {
  const daily = fakeCounter();
  const monthly = fakeCounter();
  setUp({ subExpiresAt: inYears(90), daily, monthly }); // the 100-year grant, well past 10 years left
  await withServer(async (url) => {
    for (let i = 0; i < 20; i++) {
      const r = await send(url, "hi");
      assert.strictEqual(r.status, 200, `message ${i + 1}`);
    }
  });
  assert.strictEqual(daily.rows.size, 0, "a lifetime member never touches the daily counter");
  assert.strictEqual(monthly.rows.size, 0, "...or the monthly one");
});

test("lifetime member: capped at 3600 total, ever (not per day)", async () => {
  const lifetime = fakeCounter();
  lifetime.rows.set(JSON.stringify({ user: "u@x.com" }), 3600);
  setUp({ subExpiresAt: inYears(90), lifetime });
  await withServer(async (url) => {
    const r = await send(url, "hi");
    assert.strictEqual(r.status, 429);
    assert.deepStrictEqual(await r.json(), { error: "LIFETIME_LIMIT", limit: 3600 });
  });
});

test("product-code requests count against no quota, for either tier, and bypass the model", async () => {
  const rateLimit = require("../src/rateLimit");
  rateLimit._reset(); // stay under the separate 10/minute rate limit; that's its own test below
  let modelCalled = false;
  const { daily, lifetime } = setUp({
    subExpiresAt: inYears(0.5),
    detectList: () => "all",
    converse: async () => { modelCalled = true; return { text: "should not run" }; },
  });
  productList.buildReply = async () => ({ text: "MVSD-1 (2024)", links: [], cursor: null, reset: false });
  try {
    await withServer(async (url) => {
      for (let i = 0; i < 8; i++) {
        const r = await send(url, "품번 추천해줘");
        assert.strictEqual(r.status, 200, `message ${i + 1}`);
      }
    });
  } finally {
    delete productList.buildReply;
    rateLimit._reset();
  }
  assert.strictEqual(daily.rows.size, 0, "product-code replies never touch the daily counter");
  assert.strictEqual(lifetime.rows.size, 0, "...or the lifetime one");
  assert.strictEqual(modelCalled, false, "the model is never called for a product-code request");
});

test("product-code requests are rate-limited instead (10/minute)", async () => {
  const rateLimit = require("../src/rateLimit");
  rateLimit._reset();
  setUp({ subExpiresAt: inYears(0.5), detectList: () => "all" });
  productList.buildReply = async () => ({ text: "MVSD-1 (2024)", links: [], cursor: null, reset: false });
  try {
    await withServer(async (url) => {
      let last;
      for (let i = 0; i < 11; i++) last = await send(url, "품번 추천해줘");
      assert.strictEqual(last.status, 429);
      assert.deepStrictEqual(await last.json(), { error: "RATE_LIMITED" });
    });
  } finally {
    delete productList.buildReply;
    rateLimit._reset();
  }
});

test("a model failure refunds the counter it charged (lifetime, and daily+monthly)", async () => {
  const lifetime = fakeCounter();
  setUp({ subExpiresAt: inYears(90), lifetime, converse: async () => { throw Object.assign(new Error("boom"), { response: {} }); } });
  await withServer(async (url) => {
    const r = await send(url, "hi");
    assert.strictEqual(r.status, 502);
  });
  assert.strictEqual(lifetime.rows.get(JSON.stringify({ user: "u@x.com" })), 0, "charged then refunded back to 0");
});

// ---- GET /public/titles (manko.fun, no auth) --------------------------------------------------

async function withPublicServer(fn) {
  const app = express();
  app.use(express.json());
  app.use("/chat-ai", routes);
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}/chat-ai/public/titles`);
  } finally {
    server.close();
  }
}
const postPublic = (url, body, origin) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });

test("public/titles needs no login, answers keyword requests, and sets CORS for manko.fun", async () => {
  const rateLimit = require("../src/rateLimit");
  rateLimit._reset();
  // publicReply calls buildReply/detectList internally (a same-module call, not through
  // module.exports), so it has to be given real catalogue data rather than a stubbed function.
  db.movies = () => ({
    indexExists: async () => false,
    find: () => ({
      sort: () => ({
        limit: () => ({
          toArray: async () => [{ _id: "m1", title: "MVSD-1", favorite_count: 9, category_id: "cat", share_date: "2024-01-01", actress: [] }],
        }),
      }),
    }),
  });
  db.actresses = () => ({ find: () => ({ toArray: async () => [] }) });
  try {
    await withPublicServer(async (url) => {
      const r = await postPublic(url, { text: "품번 추천", lang: "ko" }, "https://manko.fun"); // no Authorization header at all
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers.get("access-control-allow-origin"), "https://manko.fun");
      const body = await r.json();
      assert.strictEqual(body.matched, "all");
      assert.ok(body.text.includes("MVSD-1"));
    });
  } finally {
    rateLimit._reset();
  }
});

test("public/titles CORS: javclick.com and localhost are allowed too; an unlisted origin gets no CORS header", async () => {
  const rateLimit = require("../src/rateLimit");
  rateLimit._reset();
  try {
    await withPublicServer(async (url) => {
      const r1 = await postPublic(url, { text: "hi", lang: "en" }, "https://javclick.com");
      assert.strictEqual(r1.headers.get("access-control-allow-origin"), "https://javclick.com");

      const r2 = await postPublic(url, { text: "hi", lang: "en" }, "http://localhost:3000");
      assert.strictEqual(r2.headers.get("access-control-allow-origin"), "http://localhost:3000");

      const r3 = await postPublic(url, { text: "hi", lang: "en" }, "https://evil.example.com");
      assert.strictEqual(r3.headers.get("access-control-allow-origin"), null);
    });
  } finally {
    rateLimit._reset();
  }
});

test("public/titles: unmatched text gets the fixed redirect, and is rate-limited like the app's product-code path", async () => {
  const rateLimit = require("../src/rateLimit");
  rateLimit._reset();
  try {
    await withPublicServer(async (url) => {
      const r = await postPublic(url, { text: "hello there", lang: "en" });
      assert.strictEqual((await r.json()).text, productList.PUBLIC_REDIRECT.en);

      let last;
      for (let i = 0; i < 11; i++) last = await postPublic(url, { text: "hello", lang: "en" });
      assert.strictEqual(last.status, 429);
      assert.deepStrictEqual(await last.json(), { error: "RATE_LIMITED" });
    });
  } finally {
    rateLimit._reset();
  }
});
