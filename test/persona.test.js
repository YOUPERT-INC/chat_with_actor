const test = require("node:test");
const assert = require("node:assert");
const { buildSystemPrompt, languageNote, koreanOverview } = require("../src/persona");

const description = [
  { language: "zh", overview: "机器翻译的中文描述" },
  { language: "ko", overview: "BL 오타쿠 흑발 미소녀. 애칭 카렌짱." },
  { language: "en", overview: "machine translated english" },
];

test("koreanOverview returns only the ko entry", () => {
  assert.strictEqual(koreanOverview(description), "BL 오타쿠 흑발 미소녀. 애칭 카렌짱.");
  assert.strictEqual(koreanOverview([{ language: "zh", overview: "x" }]), "");
  assert.strictEqual(koreanOverview(undefined), "");
});

test("persona prompt uses Korean original, never the translations", () => {
  const p = buildSystemPrompt({
    names: { jp: "楓カレン", en: "Karen Kaede", kr: "카에데 카렌", tw: "楓可憐" },
    spec: { dob: "1999-08-25", height: 162, debut: "2018-12", size: "B82 / W59 / H81" },
    koDescription: koreanOverview(description),
  });
  assert.ok(p.includes("BL 오타쿠"));
  assert.ok(!p.includes("机器翻译"));
  assert.ok(!p.includes("machine translated"));
  assert.ok(p.includes("Karen Kaede"));
  assert.ok(p.includes("162 cm"));
  assert.ok(!p.includes("B82"), "body measurements are not fed to the persona");
  assert.ok(p.includes("NOT the real person"));
});

test("persona prompt has no language- or user-specific text (keeps prefix cache valid)", () => {
  const args = { names: { en: "A" }, spec: {}, koDescription: "한국어" };
  assert.strictEqual(buildSystemPrompt(args), buildSystemPrompt(args));
  assert.ok(!/Chat language/.test(buildSystemPrompt(args)));
});

test("languageNote maps app locales and falls back to English", () => {
  assert.match(languageNote("zh"), /Simplified Chinese/);
  assert.match(languageNote("zh-tw"), /Traditional Chinese/);
  assert.match(languageNote("th"), /Thai/);
  assert.match(languageNote(undefined), /English/);
  assert.match(languageNote("xx"), /English/);
});

test("isChattable: Korean description must reach MIN_DESCRIPTION_CHARS (default 300)", () => {
  const { isChattable } = require("../src/persona");
  assert.strictEqual(isChattable("가".repeat(299)), false);
  assert.strictEqual(isChattable("가".repeat(300)), true);
  assert.strictEqual(isChattable("  " + "가".repeat(299) + "  "), false, "whitespace does not count");
  assert.strictEqual(isChattable(""), false);
  assert.strictEqual(isChattable(undefined), false);
});
