const test = require("node:test");
const assert = require("node:assert");
const deepseek = require("../src/deepseek");
const { converseWithLookup, NO_LOOKUP_NOTE } = require("../src/lookupGuard");
const { namesTitles } = require("../src/titleLinks");

const realConverse = deepseek.converse;
test.afterEach(() => {
  deepseek.converse = realConverse;
});

test("namesTitles sees ⟦ ⟧ markers and nothing else", () => {
  assert.ok(namesTitles("Try ⟦Weapons⟧ (2025)"));
  assert.ok(!namesTitles("Just chatting, no titles"));
  assert.ok(!namesTitles(undefined));
});

test("titles named without a lookup: redone once with the note, and the retry's answer is used", async () => {
  const seen = [];
  deepseek.converse = async (messages, options) => {
    seen.push(messages);
    if (seen.length === 1) return { text: "⟦Weapons⟧ (2025) is scary" };
    options.context.knownTitles.push({ title: "군체", tmdb_id: 1 }); // the retry called the tool
    return { text: "⟦군체⟧ (2026) is scary" };
  };
  const context = { knownTitles: [] };
  const r = await converseWithLookup([{ role: "user", content: "호러 추천" }], { context });
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[1][seen[1].length - 1].content, NO_LOOKUP_NOTE);
  assert.strictEqual(r.text, "⟦군체⟧ (2026) is scary");
});

test("no retry when a lookup ran, when no titles are named, or after the one retry", async () => {
  let calls = 0;
  deepseek.converse = async (messages, options) => {
    calls++;
    options.context.knownTitles.push({ title: "군체" });
    return { text: "⟦군체⟧" };
  };
  await converseWithLookup([], { context: { knownTitles: [] } });
  assert.strictEqual(calls, 1, "a lookup ran");

  calls = 0;
  deepseek.converse = async () => {
    calls++;
    return { text: "안녕! 오늘 뭐 했어?" };
  };
  await converseWithLookup([], { context: { knownTitles: [] } });
  assert.strictEqual(calls, 1, "no titles named");

  calls = 0;
  deepseek.converse = async () => {
    calls++;
    return { text: "⟦Weapons⟧ again" };
  };
  await converseWithLookup([], { context: { knownTitles: [] } });
  assert.strictEqual(calls, 2, "only one retry");
});
