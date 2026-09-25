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
