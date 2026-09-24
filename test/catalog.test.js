const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const config = require("../src/config");
const catalog = require("../src/catalog");

const realGet = axios.get;
const realPost = axios.post;
test.afterEach(() => {
  axios.get = realGet;
  axios.post = realPost;
  catalog._clearCache();
  config.tmdbBearer = "";
});

const tmdbResult = (title, extra = {}) => ({ title, release_date: "2026-05-01", vote_average: 7.4, genre_ids: [18], adult: false, ...extra });
const recordTmdb = (results) => {
  const seen = [];
  axios.get = async (url, opts) => {
    seen.push({ url, params: opts.params, headers: opts.headers });
    return { data: { results: typeof results === "function" ? results(url, opts) : results } };
  };
  return seen;
};

test("anime: AniList query excludes adult and ecchi titles and maps fields", async () => {
  let seen;
  axios.post = async (url, body) => {
    seen = { url, body };
    return {
      data: {
        data: {
          Page: {
            media: [
              { title: { romaji: "Sousou no Frieren", english: "Frieren: Beyond Journey's End", native: "葬送のフリーレン" }, seasonYear: 2023, averageScore: 91, genres: ["Adventure", "Drama", "Fantasy", "Slice of Life", "Extra"], format: "TV" },
              { title: { romaji: "Only Romaji", english: null, native: null }, seasonYear: null, averageScore: null, genres: [], format: "MOVIE" },
            ],
          },
        },
      },
    };
  };
  const r = await catalog.getPopularTitles({ category: "anime", kind: "top_rated", count: 2 });
  assert.match(seen.url, /anilist/);
  assert.match(seen.body.query, /isAdult: false/);
  assert.match(seen.body.query, /genre_not_in: \["Ecchi"\]/);
  assert.deepStrictEqual(seen.body.variables, { perPage: 2, sort: ["SCORE_DESC"], genre: null });
  assert.strictEqual(r.source, "AniList");
  assert.strictEqual(r.items[0].title, "Frieren: Beyond Journey's End");
  assert.strictEqual(r.items[0].original_title, "葬送のフリーレン");
  assert.strictEqual(r.items[0].score, 9.1);
  assert.strictEqual(r.items[0].genres.length, 4);
  assert.strictEqual(r.items[1].title, "Only Romaji");
  assert.strictEqual(r.items[1].score, null);
});

test("anime: the default 'popular' means what is trending now, and a genre is passed through", async () => {
  let vars;
  axios.post = async (url, body) => {
    vars = body.variables;
    return { data: { data: { Page: { media: [{ title: { english: "A" } }] } } } };
  };
  const r = await catalog.getPopularTitles({ category: "anime", genre: "Slice of Life", count: 3 });
  assert.deepStrictEqual(vars, { perPage: 3, sort: ["TRENDING_DESC"], genre: "Slice of Life" });
  assert.strictEqual(r.kind, "popular");
  assert.strictEqual(r.genre, "Slice of Life");
});

test("region: the model's choice beats cf-ipcountry, which beats the chat language; unknown codes fall back", () => {
  assert.strictEqual(catalog.resolveRegion("jp", "KR", "en"), "JP");
  assert.strictEqual(catalog.resolveRegion(undefined, "kr", "en"), "KR");
  assert.strictEqual(catalog.resolveRegion(undefined, "XX", "ko"), "KR");
  assert.strictEqual(catalog.resolveRegion(undefined, "T1", "zh-tw"), "TW");
  assert.strictEqual(catalog.resolveRegion("nonsense", "", "th"), "TH");
  assert.strictEqual(catalog.resolveRegion(undefined, undefined, undefined), "US");
});

test("movie popular: recent releases in the user's region, most popular first, adult dropped", async () => {
  config.tmdbBearer = "secret-token";
  const seen = recordTmdb([tmdbResult("군체"), tmdbResult("Adult One", { adult: true }), tmdbResult("Spider-Man")]);
  const r = await catalog.getPopularTitles({ category: "movie", count: 5 }, { lang: "ko", country: "KR" });
  const call = seen[0];
  assert.match(call.url, /\/discover\/movie$/);
  assert.strictEqual(call.headers.Authorization, "Bearer secret-token");
  assert.strictEqual(call.params.region, "KR");
  assert.strictEqual(call.params.language, "ko-KR");
  assert.strictEqual(call.params.sort_by, "popularity.desc");
  assert.strictEqual(call.params.include_adult, false);
  assert.strictEqual(call.params.with_release_type, "2|3");
  assert.ok(call.params["release_date.gte"] < call.params["release_date.lte"]);
  assert.ok(call.params["primary_release_date.gte"] < call.params["release_date.gte"], "old re-releases are cut off");
  assert.deepStrictEqual(r.items.map((i) => i.title), ["군체", "Spider-Man"]);
  assert.strictEqual(r.region, "KR");
  assert.strictEqual(r.kind, "popular");
});

test("movie popular with a genre: TMDB genre id is applied; unknown genre is ignored and reported", async () => {
  config.tmdbBearer = "t";
  const seen = recordTmdb([tmdbResult("A")]);
  await catalog.getPopularTitles({ category: "movie", genre: "Romance" }, { country: "JP", lang: "ja" });
  assert.strictEqual(seen[0].params.with_genres, 10749);
  assert.strictEqual(seen[0].params.region, "JP");

  const r = await catalog.getPopularTitles({ category: "movie", genre: "Slice of Life" }, { country: "JP", lang: "ja" });
  assert.strictEqual(seen[1].params.with_genres, undefined);
  assert.strictEqual(r.genre_ignored, "Slice of Life");
  assert.strictEqual(r.genre, undefined);
});

test("tv popular: recent, airing series worldwide plus the country's own-language productions", async () => {
  config.tmdbBearer = "t";
  const seen = recordTmdb((url, opts) => (opts.params.with_original_language ? [{ name: "스캔들", first_air_date: "2026-03-01", vote_average: 8, genre_ids: [18] }] : [{ name: "Lanterns", first_air_date: "2026-04-01", vote_average: 8.3, genre_ids: [9648] }]));
  const r = await catalog.getPopularTitles({ category: "tv" }, { lang: "ko", country: "KR" });
  assert.strictEqual(seen.length, 2);
  for (const c of seen) {
    assert.match(c.url, /\/discover\/tv$/);
    assert.strictEqual(c.params.sort_by, "popularity.desc");
    assert.ok(c.params["first_air_date.gte"] && c.params["air_date.gte"]);
  }
  assert.strictEqual(seen.filter((c) => c.params.with_original_language === "ko").length, 1);
  assert.deepStrictEqual(r.items.map((i) => i.title), ["Lanterns"]);
  assert.deepStrictEqual(r.local_items.map((i) => i.title), ["스캔들"]);
  assert.strictEqual(r.region, "KR");
});

test("tv popular in an English-speaking country is a single worldwide list; genres map to TV ids", async () => {
  config.tmdbBearer = "t";
  const seen = recordTmdb([{ name: "X", first_air_date: "2026-01-01", vote_average: 7, genre_ids: [] }]);
  const r = await catalog.getPopularTitles({ category: "tv", genre: "Fantasy" }, { lang: "en", country: "US" });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].params.with_genres, 10765);
  assert.strictEqual(r.local_items, undefined);
});

test("trending and top_rated: trending endpoint (genre filtered here) and /discover with a vote floor", async () => {
  config.tmdbBearer = "t";
  const seen = recordTmdb([tmdbResult("Drama One", { genre_ids: [18] }), tmdbResult("Comedy One", { genre_ids: [35] })]);
  const trending = await catalog.getPopularTitles({ category: "movie", kind: "trending", genre: "Comedy" }, { lang: "en" });
  assert.match(seen[0].url, /\/trending\/movie\/week$/);
  assert.deepStrictEqual(trending.items.map((i) => i.title), ["Comedy One"]);

  await catalog.getPopularTitles({ category: "movie", kind: "top_rated" }, { lang: "en" });
  await catalog.getPopularTitles({ category: "tv", kind: "top_rated" }, { lang: "en" });
  assert.match(seen[1].url, /\/discover\/movie$/);
  assert.strictEqual(seen[1].params.sort_by, "vote_average.desc");
  assert.strictEqual(seen[1].params["vote_count.gte"], 5000);
  assert.strictEqual(seen[2].params["vote_count.gte"], 2000);
});

test("results are cached per region, language and genre; AniList ignores region and language", async () => {
  config.tmdbBearer = "t";
  const seen = recordTmdb([tmdbResult("X")]);
  await catalog.getPopularTitles({ category: "movie" }, { lang: "en", country: "US" });
  await catalog.getPopularTitles({ category: "movie" }, { lang: "en", country: "US" });
  assert.strictEqual(seen.length, 1);
  await catalog.getPopularTitles({ category: "movie" }, { lang: "en", country: "JP" });
  await catalog.getPopularTitles({ category: "movie" }, { lang: "ko", country: "US" });
  await catalog.getPopularTitles({ category: "movie", genre: "Drama" }, { lang: "en", country: "US" });
  assert.strictEqual(seen.length, 4);

  let anime = 0;
  axios.post = async () => {
    anime++;
    return { data: { data: { Page: { media: [{ title: { english: "A" } }] } } } };
  };
  await catalog.getPopularTitles({ category: "anime" }, { lang: "en", country: "US" });
  await catalog.getPopularTitles({ category: "anime" }, { lang: "ko", country: "KR" });
  assert.strictEqual(anime, 1);
});

test("arguments are validated and clamped; text is cleaned", async () => {
  await assert.rejects(catalog.getPopularTitles({ category: "music" }), /category/);
  await assert.rejects(catalog.getPopularTitles({}), /category/);

  let sent;
  axios.post = async (url, body) => {
    sent = body.variables;
    return { data: { data: { Page: { media: [{ title: { english: "Line1\nLine2\u0007" + "x".repeat(300) } }] } } } };
  };
  const r = await catalog.getPopularTitles({ category: "anime", kind: "bogus", count: 999 });
  assert.deepStrictEqual(sent, { perPage: 10, sort: ["TRENDING_DESC"], genre: null }, "count capped at 10, unknown kind -> popular");
  assert.ok(!/[\u0000-\u001f]/.test(r.items[0].title));
  assert.ok(r.items[0].title.length <= 120);
});

test("missing TMDB token or a broken response is an error, never an empty success", async () => {
  await assert.rejects(catalog.getPopularTitles({ category: "movie" }), /TMDB_API_BEARER/);
  config.tmdbBearer = "t";
  axios.get = async () => ({ data: { unexpected: true } });
  await assert.rejects(catalog.getPopularTitles({ category: "tv" }), /unexpected/);
});

// ---- Flix1 catalogue (random popular titles of a country) ----

const item = (names, extra = {}) => ({
  title_display_name: Object.entries(names).map(([language, title]) => ({ language, title })),
  category: "series", imdb_score: 7.66, startyear: 2024, countries: "South Korea", genre: ["Drama", "Romance", "Comedy", "Fantasy", "Extra"], ...extra,
});
function mockCatalogue(items, { lookupHost = "flix1.net", lookupFails = false } = {}) {
  const calls = [];
  axios.get = async (url, opts) => {
    calls.push({ url, params: opts && opts.params });
    if (/apiplayer\.app\/api\/lookup/.test(url)) {
      if (lookupFails) throw new Error("lookup down");
      return { data: { map: { "imdb7.plus": lookupHost } } };
    }
    return { data: { data: items, total: items.length } };
  };
  return calls;
}

test("catalogue picks: asks the M API for popular titles of the country, by English NAME with word boundaries", async () => {
  const calls = mockCatalogue([item({ ko: "눈물의 여왕", en: "Queen of Tears" })]);
  const r = await catalog.getCatalogPicks({ category: "tv", count: 5 }, { lang: "ko", country: "KR" });
  const api = calls.find((c) => /random-list/.test(c.url));
  assert.strictEqual(api.url, "https://flix1.net/swm/movie/random-list");
  assert.deepStrictEqual(api.params, { most_popular: true, size: 5, country: String.raw`\b(South Korea)\b`, category: "series" });
  assert.strictEqual(r.region, "KR");
  assert.strictEqual(r.items[0].title, "눈물의 여왕");
  assert.strictEqual(r.items[0].playable_in_app, true);
  assert.strictEqual(r.items[0].type, "tv");
  assert.strictEqual(r.items[0].score, 7.7);
  assert.strictEqual(r.items[0].genres.length, 4);
  assert.strictEqual(r.items[0].made_in, "South Korea");
});

test("catalogue picks: the API domain comes from lookup (cached), with a fallback when lookup is down", async () => {
  let calls = mockCatalogue([item({ en: "A" })], { lookupHost: "newhost.example" });
  await catalog.getCatalogPicks({}, { lang: "en", country: "US" });
  await catalog.getCatalogPicks({}, { lang: "en", country: "US" });
  assert.strictEqual(calls.filter((c) => /lookup/.test(c.url)).length, 1, "lookup answer is cached");
  assert.match(calls.find((c) => /random-list/.test(c.url)).url, /^https:\/\/newhost\.example\//);

  catalog._clearCache();
  calls = mockCatalogue([item({ en: "A" })], { lookupFails: true });
  await catalog.getCatalogPicks({}, { lang: "en", country: "US" });
  assert.match(calls.find((c) => /random-list/.test(c.url)).url, /^https:\/\/flix1\.net\//);

  catalog._clearCache();
  calls = mockCatalogue([item({ en: "A" })], { lookupHost: "not a host!!" });
  await catalog.getCatalogPicks({}, { lang: "en", country: "US" });
  assert.match(calls.find((c) => /random-list/.test(c.url)).url, /^https:\/\/flix1\.net\//, "a malformed lookup answer is ignored");
});

test("catalogue picks: never cached (random on every call)", async () => {
  const calls = mockCatalogue([item({ en: "A" })]);
  await catalog.getCatalogPicks({}, { lang: "en", country: "US" });
  await catalog.getCatalogPicks({}, { lang: "en", country: "US" });
  assert.strictEqual(calls.filter((c) => /random-list/.test(c.url)).length, 2);
});

test("catalogue picks: region choice, unknown regions go worldwide, ISO codes are never sent as the country", async () => {
  let calls = mockCatalogue([item({ en: "A" })]);
  await catalog.getCatalogPicks({ region: "jp" }, { lang: "ko", country: "KR" });
  assert.strictEqual(calls.find((c) => /random-list/.test(c.url)).params.country, String.raw`\b(Japan)\b`);

  catalog._clearCache();
  calls = mockCatalogue([item({ en: "A" })]);
  const r = await catalog.getCatalogPicks({}, { lang: "en", country: "XX" });
  const params = calls.find((c) => /random-list/.test(c.url)).params;
  assert.strictEqual(params.country, String.raw`\b(United States|USA)\b`, "XX (Cloudflare: unknown country) falls back to the language");

  catalog._clearCache();
  calls = mockCatalogue([item({ en: "A" })]);
  const w = await catalog.getCatalogPicks({ region: "BT" }, { lang: "en", country: "" });
  assert.strictEqual(calls.find((c) => /random-list/.test(c.url)).params.country, undefined);
  assert.match(w.note, /worldwide/);

  // the catalogue has no anime: answered without any request
  catalog._clearCache();
  calls = mockCatalogue([item({ en: "A" })]);
  const anime = await catalog.getCatalogPicks({ category: "anime" }, { lang: "ko", country: "KR" });
  assert.deepStrictEqual(anime.items, []);
  assert.match(anime.note, /get_popular_titles/);
  assert.strictEqual(calls.filter((c) => /random-list/.test(c.url)).length, 0);

  for (const names of Object.values(catalog.COUNTRY_NAMES)) assert.ok(names.length > 2, "no bare 2-letter codes");
});

test("catalogue picks: title language follows the chat language; copied Korean placeholders are skipped", async () => {
  mockCatalogue([
    item({ ko: "나쁜 남자", en: "Bad Guy", ja: "나쁜 남자", zh: "坏小子" }, { category: "movie" }),
    item({ ko: "동경 이야기", en: "Tokyo Story", ja: "東京物語" }, { category: "movie" }),
  ]);
  const ko = await catalog.getCatalogPicks({}, { lang: "ko", country: "KR" });
  assert.deepStrictEqual(ko.items.map((i) => i.title), ["나쁜 남자", "동경 이야기"]);
  const ja = await catalog.getCatalogPicks({}, { lang: "ja", country: "JP" });
  assert.deepStrictEqual(ja.items.map((i) => i.title), ["Bad Guy", "東京物語"], "ja entry equal to the Korean one is a placeholder");
  const zh = await catalog.getCatalogPicks({}, { lang: "zh", country: "CN" });
  assert.deepStrictEqual(zh.items.map((i) => i.title), ["坏小子", "Tokyo Story"]);
  const th = await catalog.getCatalogPicks({}, { lang: "th", country: "TH" });
  assert.deepStrictEqual(th.items.map((i) => i.title), ["Bad Guy", "Tokyo Story"], "no Thai title: English");
});

test("catalogue picks: a broken or obfuscated response is an error", async () => {
  mockCatalogue([]);
  axios.get = async (url) => (/lookup/.test(url) ? { data: { map: { "imdb7.plus": "flix1.net" } } } : { data: { data: "AbC!obfuscated" } });
  await assert.rejects(catalog.getCatalogPicks({}, { lang: "en", country: "US" }), /unexpected catalogue response/);
});
