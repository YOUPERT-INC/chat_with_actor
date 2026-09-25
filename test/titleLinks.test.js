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

test("ids of the source the title came from travel with the link, animation type stays open", () => {
  const known = [
    { title: "무빙", year: 2023, type: "tv", tmdb_id: 1, tmdb_type: "tv" },
    { title: "리버스", year: 2025, type: "animation", imdb_id: "tt123" },
  ];
  const { links } = extractTitleLinks("⟦무빙⟧ (2023) 그리고 ⟦리버스⟧", known);
  assert.deepStrictEqual([links[0].tmdb_id, links[0].type], [1, "tv"]);
  assert.deepStrictEqual([links[1].imdb_id, links[1].type, links[1].tmdb_id], ["tt123", null, undefined]);
});

test("keepOpenable trusts ids (no lookup) and adds the TMDB id found by a name search", async () => {
  let lookups = 0;
  const verify = async () => {
    lookups++;
    return { type: "movie", year: 2020, id: 77 };
  };
  const kept = await keepOpenable(
    [
      { start: 0, end: 2, title: "A", year: 2023, type: "tv", tmdb_id: 1 },
      { start: 3, end: 5, title: "B", year: null, type: null, imdb_id: "tt1" },
      { start: 6, end: 8, title: "C", year: null, type: null },
    ],
    { verify }
  );
  assert.strictEqual(lookups, 1);
  assert.strictEqual(kept.length, 3);
  assert.strictEqual(kept[2].tmdb_id, 77);
});
