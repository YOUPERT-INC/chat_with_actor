const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const config = require("../src/config");
const catalog = require("../src/catalog");

// TMDB /search/multi answers, stubbed: nothing here touches the network
const RESULTS = [
  { media_type: "person", name: "Severance" },
  { media_type: "tv", id: 95396, name: "Severance", original_name: "Severance", first_air_date: "2022-02-17" },
  { media_type: "movie", title: "무빙", original_title: "Moving", release_date: "2023-08-09" },
  { media_type: "movie", title: "Dune", original_title: "Dune", release_date: "1984-12-14" },
  { media_type: "movie", title: "Dune", original_title: "Dune", release_date: "2021-09-15" },
];

async function withStub(fn) {
  const origGet = axios.get;
  const origBearer = config.tmdbBearer;
  config.tmdbBearer = "test";
  catalog._clearCache();
  axios.get = async () => ({ data: { results: RESULTS } });
  try {
    return await fn();
  } finally {
    axios.get = origGet;
    config.tmdbBearer = origBearer;
    catalog._clearCache();
  }
}

test("a movie / series TMDB knows is found, case, spacing and punctuation ignored", () =>
  withStub(async () => {
    assert.deepStrictEqual(await catalog.findTmdbTitle("severance", { lang: "ko" }), { type: "tv", year: 2022, id: 95396 });
    assert.deepStrictEqual(await catalog.findTmdbTitle("무 빙", { year: 2023, lang: "ko" }), { type: "movie", year: 2023, id: null });
    assert.deepStrictEqual(await catalog.findTmdbTitle("Moving!", { lang: "ko" }), { type: "movie", year: 2023, id: null }); // original title
  }));

test("year narrows down remakes, type is respected, people and unknown titles are not titles", () =>
  withStub(async () => {
    assert.strictEqual((await catalog.findTmdbTitle("Dune", { year: 2021, lang: "en" })).year, 2021);
    assert.strictEqual(await catalog.findTmdbTitle("Dune", { year: 1999, lang: "en" }), null);
    assert.strictEqual(await catalog.findTmdbTitle("Severance", { type: "movie", lang: "en" }), null);
    assert.strictEqual(await catalog.findTmdbTitle("최저", { lang: "ko" }), null); // a novel
    assert.strictEqual(await catalog.findTmdbTitle("???", { lang: "ko" }), null);
  }));
