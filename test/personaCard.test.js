const test = require("node:test");
const assert = require("node:assert");
const { getCard, validateCard, sourceHash } = require("../src/personaCard");

const GOOD = [
  "Personality: Cheerful and a little shy, loves teasing gently and cares about small things.",
  "Speaking style: Casual, warm, short texts with the occasional emoji and a habit of trailing off with '...'.",
  "Interests: Swimming, karaoke, building things out of toothpicks and rewatching favourite anime late at night.",
  "Favourites: Anime: Haikyu!!, Nana, Mushishi. Films: Spirited Away, Amelie, Little Forest. Music: Yorushika, Aimyon. Food: ramen, melon soda, tuna mayo rice bowls. Games: Animal Crossing.",
  "Everyday life: Wakes up late on weekends. Has a favourite corner cafe. Swims twice a week. Always loses the umbrella she just bought. Worries about being too talkative.",
  "Conversation hooks: what she watched last night, a new cafe she found, her toothpick tower record, what the user ate today.",
].join("\n");

function memoryStore() {
  const rows = new Map();
  return {
    rows,
    find: async (id) => rows.get(id) || null,
    save: async (doc) => rows.set(doc.person_id, doc),
  };
}
const chatReturning = (text) => {
  const fn = async () => { fn.calls++; return { text }; };
  fn.calls = 0;
  return fn;
};

test("validateCard accepts a well-formed card and strips markdown noise", () => {
  assert.strictEqual(validateCard(GOOD), GOOD);
  assert.strictEqual(validateCard("```\n" + GOOD + "\n```"), GOOD);
  assert.strictEqual(validateCard(GOOD.replace("Personality:", "**Personality:**")), GOOD);
});

test("validateCard rejects too short, missing sections, links, handles, phone numbers, adult content", () => {
  assert.strictEqual(validateCard("Personality: hi"), null);
  assert.strictEqual(validateCard(GOOD.replace("Favourites", "Likes")), null);
  assert.strictEqual(validateCard(GOOD + "\nFollow her at https://example.com"), null);
  assert.strictEqual(validateCard(GOOD + "\nInstagram @karen_kaede_official"), null);
  assert.strictEqual(validateCard(GOOD + "\nCall 010-1234-5678"), null);
  assert.strictEqual(validateCard(GOOD + "\nShe loves erotic roleplay."), null);
  assert.strictEqual(validateCard(GOOD + "\n성적인 대화를 좋아함"), null);
  assert.strictEqual(validateCard("x".repeat(3000)), null);
});

test("getCard generates once, stores it, and reuses the stored card", async () => {
  const store = memoryStore();
  const chat = chatReturning(GOOD);
  const a = await getCard("card-a", "한국어 설명", { store, chat });
  const b = await getCard("card-a", "한국어 설명", { store, chat });
  assert.strictEqual(a, GOOD);
  assert.strictEqual(b, GOOD);
  assert.strictEqual(chat.calls, 1);
  assert.strictEqual(store.rows.get("card-a").source_hash, sourceHash("한국어 설명"));
});

test("a stored card is frozen: a changed Korean description does not regenerate it", async () => {
  const store = memoryStore();
  const chat = chatReturning(GOOD);
  await getCard("card-b", "설명 하나", { store, chat });
  const again = await getCard("card-b", "설명 하나 그리고 더 길어짐", { store, chat });
  assert.strictEqual(again, GOOD);
  assert.strictEqual(chat.calls, 1);
  assert.strictEqual(store.rows.get("card-b").source_hash, sourceHash("설명 하나"), "still records what it was made from");
});

test("concurrent first requests share one generation", async () => {
  const store = memoryStore();
  const chat = chatReturning(GOOD);
  const results = await Promise.all([1, 2, 3].map(() => getCard("card-c", "설명", { store, chat })));
  assert.deepStrictEqual(results, [GOOD, GOOD, GOOD]);
  assert.strictEqual(chat.calls, 1);
});

test("a rejected or failed generation gives null (chat still works) and is not retried right away", async () => {
  const store = memoryStore();
  const bad = chatReturning("nope");
  assert.strictEqual(await getCard("card-d", "설명", { store, chat: bad }), null);
  assert.strictEqual(bad.calls, 2, "one attempt = the first try plus one retry");
  assert.strictEqual(await getCard("card-d", "설명", { store, chat: bad }), null);
  assert.strictEqual(bad.calls, 2, "no new attempt right after a failure");
  assert.strictEqual(store.rows.size, 0, "nothing invalid is stored");

  const boom = async () => { throw new Error("model down"); };
  assert.strictEqual(await getCard("card-e", "설명", { store, chat: boom }), null);
});

test("a storage read error degrades to no card instead of throwing", async () => {
  const store = { find: async () => { throw new Error("mongo down"); }, save: async () => {} };
  assert.strictEqual(await getCard("card-f", "설명", { store, chat: chatReturning(GOOD) }), null);
});

test("trailing meta remarks by the model are removed from the card", () => {
  const withNote = GOOD + "\n\nNote: She's a fictional character inspired by the profile above, not the real person.";
  assert.strictEqual(validateCard(withNote), GOOD);
});

test("generateCard retries once when the first card is rejected", async () => {
  const { generateCard } = require("../src/personaCard");
  let n = 0;
  const chat = async () => ({ text: n++ === 0 ? "too short" : GOOD });
  assert.strictEqual(await generateCard("설명", chat), GOOD);
  assert.strictEqual(n, 2);
  let m = 0;
  assert.strictEqual(await generateCard("설명", async () => { m++; return { text: "bad" }; }), null);
  assert.strictEqual(m, 2, "gives up after the second rejection");
});
