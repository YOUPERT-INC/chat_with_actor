const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { requireUser } = require("../src/auth");

async function withServer(fn) {
  const app = express();
  app.get("/x", requireUser, (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}/x`);
  } finally {
    server.close();
  }
}

test("no bearer token -> 401 LOGIN_REQUIRED", async () => {
  await withServer(async (url) => {
    const r = await fetch(url);
    assert.strictEqual(r.status, 401);
    assert.strictEqual((await r.json()).error, "LOGIN_REQUIRED");
  });
});

test("'Bearer null' -> 401", async () => {
  await withServer(async (url) => {
    const r = await fetch(url, { headers: { Authorization: "Bearer null" } });
    assert.strictEqual(r.status, 401);
  });
});

const { _setFetchProfile } = require("../src/auth");

async function loginStatus(url) {
  const r = await fetch(url, { headers: { Authorization: "Bearer tok" } });
  return r.status;
}

test("account server host order: apiplayer.app first, api.flix1.net on failure", async () => {
  const hosts = [];
  _setFetchProfile(async (host) => {
    hosts.push(host);
    if (host === "apiplayer.app") throw new Error("ECONNRESET");
    return { email: "a@x.com", sub_expires_at: 0 };
  });
  await withServer(async (url) => assert.strictEqual(await loginStatus(url), 200));
  assert.deepStrictEqual(hosts, ["apiplayer.app", "api.flix1.net"]);
});

test("an invalid token is answered by the first server and is NOT retried on the fallback", async () => {
  const hosts = [];
  _setFetchProfile(async (host) => { hosts.push(host); return null; });
  await withServer(async (url) => assert.strictEqual(await loginStatus(url), 401));
  assert.deepStrictEqual(hosts, ["apiplayer.app"]);
});

test("both account servers down -> 502 AUTH_UNAVAILABLE (not 401)", async () => {
  _setFetchProfile(async () => { throw new Error("down"); });
  await withServer(async (url) => assert.strictEqual(await loginStatus(url), 502));
});

test("a client-supplied x-auth-host header is ignored", async () => {
  const hosts = [];
  _setFetchProfile(async (host) => { hosts.push(host); return { email: "b@x.com", sub_expires_at: 0 }; });
  await withServer(async (url) => {
    const r = await fetch(url, { headers: { Authorization: "Bearer tok2", "x-auth-host": "evil.example.com" } });
    assert.strictEqual(r.status, 200);
  });
  assert.deepStrictEqual(hosts, ["apiplayer.app"]);
});

// ---- isLifetime (membership balance >= lifetimeThresholdYears -> lifetime message quota) -----

const { isLifetime } = require("../src/auth");
const YEAR_MS = 365.25 * 24 * 3600 * 1000;

test("isLifetime: the 100-year grant clears the (default 10-year) threshold; ordinary plans don't", () => {
  const now = Date.now();
  assert.strictEqual(isLifetime({ subExpiresAt: now + 100 * YEAR_MS }), true, "lifetime grant");
  assert.strictEqual(isLifetime({ subExpiresAt: now + 10 * YEAR_MS + 1000 }), true, "just over the threshold");
  assert.strictEqual(isLifetime({ subExpiresAt: now + 10 * YEAR_MS - 1000 }), false, "just under the threshold");
  assert.strictEqual(isLifetime({ subExpiresAt: now + 12 * 30 * 24 * 3600 * 1000 }), false, "12-month plan");
  assert.strictEqual(isLifetime({ subExpiresAt: now - 1000 }), false, "expired");
});
