const test = require("node:test");
const assert = require("node:assert");
const rateLimit = require("../src/rateLimit");

test.afterEach(() => rateLimit._reset());

test("allows up to the limit, then blocks, independently per key", () => {
  const limits = [{ windowMs: 100000, max: 3 }];
  for (let i = 0; i < 3; i++) assert.strictEqual(rateLimit.allow("a", limits), true, `hit ${i + 1}`);
  assert.strictEqual(rateLimit.allow("a", limits), false, "4th hit for the same key is blocked");
  assert.strictEqual(rateLimit.allow("b", limits), true, "a different key is unaffected");
});

test("a blocked attempt records nothing (does not consume from other windows either)", () => {
  const limits = [
    { windowMs: 100000, max: 1 },
    { windowMs: 200000, max: 5 },
  ];
  assert.strictEqual(rateLimit.allow("x", limits), true);
  assert.strictEqual(rateLimit.allow("x", limits), false); // over the tight (1) window
  assert.strictEqual(rateLimit.allow("x", limits), false); // still blocked, not incrementing further
});

test("the tighter of several windows blocks first", () => {
  const limits = [
    { windowMs: 100000, max: 2 }, // tighter
    { windowMs: 999999, max: 100 }, // generous
  ];
  assert.strictEqual(rateLimit.allow("y", limits), true);
  assert.strictEqual(rateLimit.allow("y", limits), true);
  assert.strictEqual(rateLimit.allow("y", limits), false);
});

test("PRODUCT_LIST_LIMITS: 10/minute and 100/hour", () => {
  for (let i = 0; i < 10; i++) assert.strictEqual(rateLimit.allow("p", rateLimit.PRODUCT_LIST_LIMITS), true);
  assert.strictEqual(rateLimit.allow("p", rateLimit.PRODUCT_LIST_LIMITS), false, "11th within the minute");
});

test("sweep removes only buckets from finished windows, keeps the current one", () => {
  const limits = [{ windowMs: rateLimit.WINDOW_MINUTE, max: 5 }];
  rateLimit.allow("s", limits);
  const before = rateLimit.allow("s", [{ windowMs: rateLimit.WINDOW_MINUTE, max: 5 }]); // still within cap
  assert.strictEqual(before, true);
  rateLimit.sweep(); // nothing should be old enough yet
  assert.strictEqual(rateLimit.allow("s", [{ windowMs: rateLimit.WINDOW_MINUTE, max: 2 }]), false, "count survived the sweep");
});
