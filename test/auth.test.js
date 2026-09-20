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

test("auth host outside the allowlist -> 400 (no outbound request)", async () => {
  await withServer(async (url) => {
    const r = await fetch(url, { headers: { Authorization: "Bearer abc", "x-auth-host": "evil.example.com" } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await r.json()).error, "BAD_AUTH_HOST");
  });
});
