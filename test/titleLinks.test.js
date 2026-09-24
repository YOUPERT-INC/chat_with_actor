const test = require("node:test");
const assert = require("node:assert");
const { extractTitleLinks, applyMarkers, stripMarkers } = require("../src/titleLinks");

test("markers become offsets and disappear from the text", () => {
  const { text, links } = extractTitleLinks("추천: ⟦오디세이⟧ (2026), 그리고 ⟦기생충⟧도 좋아요.");
  assert.strictEqual(text, "추천: 오디세이 (2026), 그리고 기생충도 좋아요.");
  assert.strictEqual(links.length, 2);
  assert.strictEqual(text.slice(links[0].start, links[0].end), "오디세이");
  assert.strictEqual(links[0].year, 2026);
  assert.strictEqual(text.slice(links[1].start, links[1].end), "기생충");
  assert.strictEqual(links[1].year, null);
});

test("type and year come from tool results when the model gave none", () => {
  const known = [{ title: "Severance", year: 2022, type: "tv" }];
  const { links } = extractTitleLinks("Try ⟦severance⟧!", known);
  assert.strictEqual(links[0].type, "tv");
  assert.strictEqual(links[0].year, 2022);
});

test("stray or unclosed brackets are removed", () => {
  const { text, links } = extractTitleLinks("cut off ⟦Some Titl");
  assert.strictEqual(text, "cut off Some Titl");
  assert.strictEqual(links.length, 0);
});

test("applyMarkers restores what extract removed", () => {
  const original = "Try ⟦Severance⟧ (2022) and ⟦Dark⟧.";
  const { text, links } = extractTitleLinks(original);
  assert.strictEqual(applyMarkers(text, links), original);
  assert.strictEqual(stripMarkers(original), text);
});

const { keepOpenable, bookTitles } = require("../src/titleLinks");

test("bookTitles reads both names of numbered book lines", () => {
  const facts = '1. 「최저。」 (最低。, "Saitei.") - debut\n2. 「요철」 (凹凸, "Outotsu") - novel';
  const names = bookTitles(facts);
  for (const n of ["최저", "最低", "요철", "凹凸"]) assert.ok(names.has(n), n);
});

test("keepOpenable drops books, unknown titles and failed checks; fills type and year", async () => {
  const links = [
    { start: 0, end: 2, title: "최저", year: null, type: null }, // her book
    { start: 3, end: 6, title: "Severance", year: null, type: null }, // known series
    { start: 7, end: 9, title: "Some Novel", year: 2001, type: null }, // TMDB has no such movie/series
    { start: 10, end: 12, title: "Boom", year: null, type: null }, // check fails
  ];
  const verify = async (l) => {
    if (l.title === "Severance") return { type: "tv", year: 2022 };
    if (l.title === "Boom") throw new Error("timeout");
    return null;
  };
  const kept = await keepOpenable(links, { exclude: bookTitles('1. 「최저。」 (最低。, "x")'), verify });
  assert.strictEqual(kept.length, 1);
  assert.deepStrictEqual([kept[0].title, kept[0].type, kept[0].year], ["Severance", "tv", 2022]);
});
