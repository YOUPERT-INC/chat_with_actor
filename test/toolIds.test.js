const test = require("node:test");
const assert = require("node:assert");
const catalog = require("../src/catalog");
const { runTool, toolDefsFor } = require("../src/tools");

test("runTool keeps ids for the server (knownTitles) and hides them from the model", async () => {
  const orig = catalog.getTitles;
  catalog.getTitles = async () => ({
    category: "movie",
    scope: "global",
    items: [
      { title: "Dune", year: 2021, score: 8, tmdb_id: 438631, tmdb_type: "movie" },
      { title: "Moving", year: 2023, tmdb_id: 1, tmdb_type: "tv" },
    ],
  });
  try {
    const context = { lang: "en", knownTitles: [] };
    const shown = await runTool("get_titles", { category: "movie" }, context);
    assert.ok(!JSON.stringify(shown).includes("tmdb_id") && !JSON.stringify(shown).includes("tmdb_type"));
    assert.strictEqual(shown.items[0].title, "Dune");
    assert.deepStrictEqual(context.knownTitles.map((k) => [k.title, k.tmdb_id, k.type]), [["Dune", 438631, "movie"], ["Moving", 1, "tv"]]);
  } finally {
    catalog.getTitles = orig;
  }
});

test("one recommendation tool (TMDB parameters); the old catalogue tool is gone", () => {
  const names = toolDefsFor({ lang: "en" }).map((t) => t.function.name);
  assert.deepStrictEqual(names, ["get_titles"]);
});

// ---- no repeats within a conversation ----

const item = (n, type = "movie") => ({ title: `T${n}`, year: 2025, tmdb_id: n, tmdb_type: type });

async function withPages(pages, fn) {
  const orig = catalog.getTitles;
  const calls = [];
  catalog.getTitles = async (args) => {
    calls.push(args.page);
    return { category: "movie", scope: "global", items: pages[args.page - 1] || [] };
  };
  try {
    return await fn(calls);
  } finally {
    catalog.getTitles = orig;
  }
}

const full = (from) => Array.from({ length: 20 }, (_, i) => item(from + i)); // a whole TMDB page

test("titles already recommended in this conversation are skipped; later pages fill the gap", async () => {
  await withPages([full(1), full(21)], async (calls) => {
    const context = { knownTitles: [], recommended: new Set(["movie:1", "movie:2", "movie:3"]) };
    const r = await runTool("get_titles", { category: "movie", count: 5 }, context);
    assert.deepStrictEqual(r.items.map((i) => i.title), ["T4", "T5", "T6", "T7", "T8"]);
    assert.deepStrictEqual(calls, [1]);
    assert.match(r.note, /already recommended/);
  });
});

test("when a page has too few new titles the next page is read (at most 3 pages)", async () => {
  const seen = new Set(Array.from({ length: 18 }, (_, i) => `movie:${i + 1}`));
  await withPages([full(1), full(21), full(41)], async (calls) => {
    const r = await runTool("get_titles", { category: "movie", count: 5 }, { knownTitles: [], recommended: seen });
    assert.deepStrictEqual(r.items.map((i) => i.title), ["T19", "T20", "T21", "T22", "T23"]);
    assert.deepStrictEqual(calls, [1, 2]);
  });
  await withPages([full(1), full(21), full(41), full(61)], async (calls) => {
    const all = new Set(Array.from({ length: 60 }, (_, i) => `movie:${i + 1}`));
    const r = await runTool("get_titles", { category: "movie", count: 5 }, { knownTitles: [], recommended: all });
    assert.strictEqual(r.items.length, 0);
    assert.deepStrictEqual(calls, [1, 2, 3], "gives up after 3 pages");
  });
});

test("two calls of the same turn (global + country) do not return the same title twice", async () => {
  await withPages([full(1)], async () => {
    const context = { knownTitles: [], recommended: new Set() };
    const [a, b] = await Promise.all([
      runTool("get_titles", { category: "movie", count: 3 }, context),
      runTool("get_titles", { category: "movie", count: 3 }, context),
    ]);
    const titles = [...a.items, ...b.items].map((i) => i.title);
    assert.strictEqual(new Set(titles).size, 6);
  });
});

test("a movie and a series with the same TMDB id are different titles", async () => {
  await withPages([[item(5, "movie"), item(5, "tv"), item(6, "tv")]], async () => {
    const r = await runTool("get_titles", { category: "movie", count: 5 }, { knownTitles: [], recommended: new Set(["movie:5"]) });
    assert.deepStrictEqual(r.items.map((i) => `${i.title}`), ["T5", "T6"]);
  });
});
