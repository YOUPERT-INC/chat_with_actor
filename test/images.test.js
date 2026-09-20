const test = require("node:test");
const assert = require("node:assert");
const { avatarUrl, imageBase } = require("../src/images");

const RAW = "https://s3.ap-northeast-1.wasabisys.com/swipesub/actress/avatars/kz/kzx6.jpg";

test("avatar follows the domain the app called (lookup-driven, all four work)", () => {
  for (const h of ["healertanker.com", "robustx.shop", "chinaevergreeen.com", "healmaker.shop"]) {
    assert.strictEqual(avatarUrl(RAW, h), `https://image.${h}/actress/avatars/kz/kzx6.jpg`);
  }
});

test("port is ignored; non-domain hosts leave the URL untouched", () => {
  assert.strictEqual(avatarUrl(RAW, "healertanker.com:443"), "https://image.healertanker.com/actress/avatars/kz/kzx6.jpg");
  for (const h of ["localhost", "localhost:8004", "127.0.0.1", "172.104.71.28:80", "", undefined]) {
    assert.strictEqual(avatarUrl(RAW, h), RAW, String(h));
    assert.strictEqual(imageBase(h), null, String(h));
  }
});

test("non-wasabi or empty avatars are passed through", () => {
  assert.strictEqual(avatarUrl("https://other.example/a.jpg", "healertanker.com"), "https://other.example/a.jpg");
  assert.strictEqual(avatarUrl("", "healertanker.com"), "");
  assert.strictEqual(avatarUrl(undefined, "healertanker.com"), "");
});
