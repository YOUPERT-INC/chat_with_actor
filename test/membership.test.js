const test = require("node:test");
const assert = require("node:assert");
const { membershipActive, _setFetchProfile } = require("../src/auth");

const DAY = 24 * 3600 * 1000;
const req = () => ({ user: null, auth: { host: "apiplayer.app", token: "t" } });

// requireUser needs express; drive membershipActive through a hand-built req instead
function setup(profiles) {
  let calls = 0;
  _setFetchProfile(async () => {
    const p = profiles[Math.min(calls, profiles.length - 1)];
    calls++;
    return p;
  });
  return () => calls;
}
async function login(r) {
  // same path requireUser takes: first verify populates req.user
  const auth = require("../src/auth");
  const express = require("express");
  const app = express();
  let user;
  app.get("/", auth.requireUser, (q, s) => { user = q.user; s.json({}); });
  const server = app.listen(0);
  await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { Authorization: "Bearer t" } });
  server.close();
  r.user = user;
}

test("future sub_expires_at -> active, cached (no second profile call)", async () => {
  const calls = setup([{ email: "A@x.com", sub_expires_at: Date.now() + DAY }]);
  const r = req();
  await login(r);
  assert.strictEqual(await membershipActive(r), true);
  assert.strictEqual(await membershipActive(r), true);
  assert.strictEqual(calls(), 1);
  assert.strictEqual(r.user.email, "a@x.com");
});

test("no membership -> re-checked live every time; just-subscribed user gets in immediately", async () => {
  const calls = setup([
    { email: "b@x.com", sub_expires_at: 0 },                    // login: no membership
    { email: "b@x.com", sub_expires_at: 0 },                    // retry: still none
    { email: "b@x.com", sub_expires_at: Date.now() + 30 * DAY }, // bought a plan
  ]);
  const r = req();
  await login(r);
  assert.strictEqual(await membershipActive(r), false);
  assert.strictEqual(await membershipActive(r), true, "must not stay blocked for the 10-minute cache window");
  assert.strictEqual(calls(), 3);
});

test("cached expiry that has passed -> re-checked live", async () => {
  const calls = setup([
    { email: "c@x.com", sub_expires_at: Date.now() + 50 },
    { email: "c@x.com", sub_expires_at: Date.now() - 1000 },
  ]);
  const r = req();
  await login(r);
  await new Promise((res) => setTimeout(res, 80));
  assert.strictEqual(await membershipActive(r), false);
  assert.strictEqual(calls(), 2);
});

test("sub_expires_at in seconds is understood; missing/garbage means no membership", async () => {
  setup([{ email: "d@x.com", sub_expires_at: Math.floor(Date.now() / 1000) + 3600 }]);
  const r1 = req(); await login(r1);
  assert.strictEqual(await membershipActive(r1), true);

  for (const v of [undefined, null, "abc", -5]) {
    setup([{ email: "e@x.com", sub_expires_at: v }]);
    const r = req(); await login(r);
    assert.strictEqual(await membershipActive(r), false, `value ${v}`);
  }
});

test("account server down during the live re-check -> AUTH_UNAVAILABLE, not 'no membership'", async () => {
  let n = 0;
  _setFetchProfile(async () => {
    if (n++ === 0) return { email: "f@x.com", sub_expires_at: 0 };
    throw new Error("ECONNRESET");
  });
  const r = req(); await login(r);
  await assert.rejects(membershipActive(r), (e) => e.code === "AUTH_UNAVAILABLE");
});
