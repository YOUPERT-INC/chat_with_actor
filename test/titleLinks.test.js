const test = require("node:test");
const assert = require("node:assert");
const { extractTitleLinks, applyMarkers, stripMarkers, keepOpenable } = require("../src/titleLinks");

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

test("a title matches its tool result with case, spacing and punctuation ignored, by title or original title", () => {
  const known = [
    { title: "Spider-Man: Homecoming", year: 2017, type: "movie", tmdb_id: 315635 },
    { title: "와호장룡", original_title: "臥虎藏龍", year: 2000, type: "movie", tmdb_id: 146 },
  ];
  const { links } = extractTitleLinks("⟦Spider Man Homecoming⟧ (2017) 그리고 ⟦臥虎藏龍⟧ (2000)", known);
  assert.deepStrictEqual(links.map((l) => l.tmdb_id), [315635, 146]);
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

test("ids of the source the title came from travel with the link, animation type stays open", () => {
  const known = [
    { title: "무빙", year: 2023, type: "tv", tmdb_id: 1, tmdb_type: "tv" },
    { title: "리버스", year: 2025, type: "animation", imdb_id: "tt123" },
  ];
  const { links } = extractTitleLinks("⟦무빙⟧ (2023) 그리고 ⟦리버스⟧", known);
  assert.deepStrictEqual([links[0].tmdb_id, links[0].type], [1, "tv"]);
  assert.deepStrictEqual([links[1].imdb_id, links[1].type, links[1].tmdb_id], ["tt123", null, undefined]);
});

test("keepOpenable keeps only titles that came from a tool result (they have an id); no name search", () => {
  const kept = keepOpenable([
    { start: 0, end: 2, title: "A", year: 2023, type: "tv", tmdb_id: 1 },
    { start: 3, end: 5, title: "B", year: null, type: null, imdb_id: "tt1" },
    { start: 6, end: 8, title: "Written from memory", year: 2001, type: null },
  ]);
  assert.deepStrictEqual(kept.map((l) => l.title), ["A", "B"]);
});

test("her own titles (product codes, movie_id) become links too, with thumbnail/cover carried over", () => {
  const known = [{ title: "ABC-100", year: 2024, type: "av", movie_id: "id000", thumbnail: "https://img.test/t.jpg", cover: "https://img.test/c.jpg" }];
  const { text, links } = extractTitleLinks("오늘은 ⟦ABC-100⟧ (2024) 추천할게", known);
  assert.strictEqual(text, "오늘은 ABC-100 (2024) 추천할게");
  assert.deepStrictEqual(links[0].type, "av");
  assert.strictEqual(links[0].movie_id, "id000");
  assert.strictEqual(links[0].thumbnail, "https://img.test/t.jpg");
  assert.strictEqual(links[0].cover, "https://img.test/c.jpg");
});

test("keepOpenable also keeps a movie_id-only link (her own titles have no TMDB/IMDb id)", () => {
  const kept = keepOpenable([
    { start: 0, end: 2, title: "A", year: 2024, type: "av", movie_id: "id000" },
    { start: 3, end: 5, title: "Written from memory", year: 2001, type: "av" },
  ]);
  assert.deepStrictEqual(kept.map((l) => l.title), ["A"]);
});
