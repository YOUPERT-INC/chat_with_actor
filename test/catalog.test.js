const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const config = require("../src/config");
const catalog = require("../src/catalog");

const realGet = axios.get;
test.afterEach(() => {
  axios.get = realGet;
  catalog._clearCache();
  config.tmdbBearer = "";
});

const movie = (title, extra = {}) => ({ id: 1, title, original_title: title, release_date: "2026-05-01", vote_average: 7.4, genre_ids: [18], adult: false, ...extra });
const show = (name, extra = {}) => ({ id: 2, name, original_name: name, first_air_date: "2026-03-01", vote_average: 8, genre_ids: [18], adult: false, ...extra });
const recordTmdb = (results) => {
  const seen = [];
  axios.get = async (url, opts) => {
    seen.push({ url, params: opts.params, headers: opts.headers });
    return { data: { results: typeof results === "function" ? results(url, opts, seen.length) : results } };
  };
  return seen;
};
const many = (make, n) => Array.from({ length: n }, (_, i) => make(`T${i}`));

test("region: the model's choice beats cf-ipcountry, which beats the chat language; unknown codes fall back", () => {
  assert.strictEqual(catalog.resolveRegion("jp", "KR", "en"), "JP");
  assert.strictEqual(catalog.resolveRegion(undefined, "kr", "en"), "KR");
  assert.strictEqual(catalog.resolveRegion(undefined, "XX", "ko"), "KR");
  assert.strictEqual(catalog.resolveRegion(undefined, "T1", "zh-tw"), "TW");
  assert.strictEqual(catalog.resolveRegion("nonsense", "", "th"), "TH");
  assert.strictEqual(catalog.resolveRegion(undefined, undefined, undefined), "US");
});

test("movie popular, global: recent releases, most popular first, no country filter, adult dropped, ids kept", async () => {
  config.tmdbBearer = "secret-token";
  const seen = recordTmdb(many((t) => movie(t), 5).concat([movie("Adult One", { adult: true })]));
  const r = await catalog.getTitles({ category: "movie", count: 5 }, { lang: "ko", country: "KR" });
  const p = seen[0].params;
  assert.match(seen[0].url, /\/discover\/movie$/);
  assert.strictEqual(seen[0].headers.Authorization, "Bearer secret-token");
  assert.strictEqual(p.language, "ko-KR");
  assert.strictEqual(p.sort_by, "popularity.desc");
  assert.strictEqual(p.include_adult, false);
  assert.strictEqual(p.with_origin_country, undefined, "global means no country filter");
  assert.strictEqual(p.region, undefined);
  assert.ok(p["primary_release_date.gte"] < p["primary_release_date.lte"]);
  assert.strictEqual(r.scope, "global");
  assert.strictEqual(r.region, undefined);
  assert.strictEqual(r.items.length, 5);
  assert.ok(!r.items.some((i) => i.title === "Adult One"));
  assert.strictEqual(r.items[0].tmdb_id, 1);
});

test("country scope means titles MADE in that country; the user's country is the default", async () => {
  config.tmdbBearer = "t";
  const seen = recordTmdb(many((t) => movie(t), 5));
  let r = await catalog.getTitles({ category: "movie", scope: "country" }, { lang: "zh", country: "CN" });
  assert.strictEqual(seen[0].params.with_origin_country, "CN");
  assert.strictEqual(r.region, "CN");
  // an explicit region wins, and a region alone already means country scope
  r = await catalog.getTitles({ category: "movie", region: "jp" }, { lang: "zh", country: "CN" });
  assert.strictEqual(seen[1].params.with_origin_country, "JP");
  assert.strictEqual(r.scope, "country");
  // scope=global ignores a stray region
  await catalog.getTitles({ category: "movie", scope: "global", region: "JP" }, { lang: "en" });
  assert.strictEqual(seen[2].params.with_origin_country, undefined);
});

test("a country with few recent titles: the recent window is widened once", async () => {
  config.tmdbBearer = "t";
  const seen = recordTmdb((url, opts, n) => (n === 1 ? [movie("Only One")] : many((t) => movie(t), 5)));
  const r = await catalog.getTitles({ category: "movie", scope: "country", region: "CN" }, { lang: "zh" });
  assert.strictEqual(seen.length, 2);
  assert.ok(seen[1].params["primary_release_date.gte"] < seen[0].params["primary_release_date.gte"]);
  assert.strictEqual(r.items.length, 5);
});

test("genres: TMDB ids (all must match), unknown genres are ignored and reported", async () => {
  config.tmdbBearer = "t";
  const seen = recordTmdb(many((t) => movie(t), 5));
  await catalog.getTitles({ category: "movie", genres: ["Horror", "Comedy"] }, { lang: "en" });
  assert.strictEqual(seen[0].params.with_genres, "27,35");
  const r = await catalog.getTitles({ category: "movie", genre: "Slice of Life" }, { lang: "en" });
  assert.strictEqual(seen[1].params.with_genres, undefined);
  assert.strictEqual(r.genre_ignored, "Slice of Life");
  assert.strictEqual(r.genre, undefined);
  // TV has merged genres: two names with one id give one id
  await catalog.getTitles({ category: "tv", genres: ["Action", "Adventure"] }, { lang: "en" });
  assert.strictEqual(seen[2].params.with_genres, "10759");
});

test("tv popular: recent, airing series; anime is Japanese-language animation", async () => {
  config.tmdbBearer = "t";
  const seen = recordTmdb(many((t) => show(t), 5));
  await catalog.getTitles({ category: "tv" }, { lang: "ko" });
  assert.match(seen[0].url, /\/discover\/tv$/);
  assert.ok(seen[0].params["first_air_date.gte"] && seen[0].params["air_date.gte"]);
  await catalog.getTitles({ category: "anime", genres: ["Fantasy"] }, { lang: "en" });
  assert.match(seen[1].url, /\/discover\/tv$/);
  assert.strictEqual(seen[1].params.with_original_language, "ja");
  assert.strictEqual(seen[1].params.with_genres, "16,10765");
});

test("top_rated: rating sort with a vote floor (lower for one country); trending: the trending endpoint, genres filtered here", async () => {
  config.tmdbBearer = "t";
  const seen = recordTmdb([movie("Old Classic", { genre_ids: [27] }), movie("Other", { genre_ids: [35] })]);
  await catalog.getTitles({ category: "movie", kind: "top_rated" }, { lang: "en" });
  assert.strictEqual(seen[0].params.sort_by, "vote_average.desc");
  assert.strictEqual(seen[0].params["vote_count.gte"], 5000);
  assert.strictEqual(seen[0].params["primary_release_date.gte"], undefined, "no recent window for all-time lists");
  await catalog.getTitles({ category: "tv", kind: "top_rated", region: "KR" }, { lang: "en" });
  assert.strictEqual(seen[1].params["vote_count.gte"], 200);
  const t = await catalog.getTitles({ category: "movie", kind: "trending", genres: ["Horror"] }, { lang: "en" });
  assert.match(seen[2].url, /\/trending\/movie\/week$/);
  assert.deepStrictEqual(t.items.map((i) => i.title), ["Old Classic"]);
  // a country or another filter cannot be asked of the trending endpoint: popular list instead
  await catalog.getTitles({ category: "movie", kind: "trending", scope: "country", region: "KR" }, { lang: "en" });
  assert.match(seen[3].url, /\/discover\/movie$/);
});

test("year range, minimum rating, runtime and language become TMDB filters and replace the recent window", async () => {
  config.tmdbBearer = "t";
  const seen = recordTmdb(many((t) => movie(t), 5));
  await catalog.getTitles({ category: "movie", year_from: 1990, year_to: 1999, min_rating: 7.5, max_runtime: 100, original_language: "ko" }, { lang: "en" });
  const p = seen[0].params;
  assert.strictEqual(p["primary_release_date.gte"], "1990-01-01");
  assert.strictEqual(p["primary_release_date.lte"], "1999-12-31");
  assert.strictEqual(p["vote_average.gte"], 7.5);
  assert.strictEqual(p["vote_count.gte"], 300);
  assert.strictEqual(p["with_runtime.lte"], 100);
  assert.strictEqual(p.with_original_language, "ko");
  // reversed years are fixed, nonsense is dropped; runtime is for movies only
  await catalog.getTitles({ category: "tv", year_from: 2020, year_to: 2010, max_runtime: 90, min_rating: 99, original_language: "korean" }, { lang: "en" });
  const q = seen[1].params;
  assert.strictEqual(q["first_air_date.gte"], "2010-01-01");
  assert.strictEqual(q["first_air_date.lte"], "2020-12-31");
  assert.strictEqual(q["with_runtime.lte"], undefined);
  assert.strictEqual(q["vote_average.gte"], undefined);
  assert.strictEqual(q.with_original_language, undefined);
});

test("results are cached per request (scope, region, genre, language)", async () => {
  config.tmdbBearer = "t";
  const seen = recordTmdb(many((t) => movie(t), 5));
  await catalog.getTitles({ category: "movie" }, { lang: "en" });
  await catalog.getTitles({ category: "movie" }, { lang: "en" });
  assert.strictEqual(seen.length, 1);
  await catalog.getTitles({ category: "movie", scope: "country", region: "KR" }, { lang: "en" });
  await catalog.getTitles({ category: "movie" }, { lang: "ko" });
  assert.strictEqual(seen.length, 3);
});

test("arguments are validated and clamped; text is cleaned", async () => {
  config.tmdbBearer = "t";
  await assert.rejects(catalog.getTitles({ category: "music" }), /category/);
  await assert.rejects(catalog.getTitles({}), /category/);
  const seen = recordTmdb([movie("Line1\nLine2\u0007" + "x".repeat(300))]);
  const r = await catalog.getTitles({ category: "movie", kind: "bogus", count: 999 }, { lang: "en" });
  assert.strictEqual(seen[0].params.sort_by, "popularity.desc", "unknown kind -> popular");
  assert.ok(!/[\u0000-\u001f]/.test(r.items[0].title));
  assert.ok(r.items[0].title.length <= 120);
});

test("missing TMDB token or a broken response is an error, never an empty success", async () => {
  await assert.rejects(catalog.getTitles({ category: "movie" }), /TMDB_API_BEARER/);
  config.tmdbBearer = "t";
  axios.get = async () => ({ data: { unexpected: true } });
  await assert.rejects(catalog.getTitles({ category: "tv" }), /unexpected/);
});
