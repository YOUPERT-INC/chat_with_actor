/**
 * Live "what is popular right now" charts for recommendations.
 *   anime        -> AniList GraphQL (no key)
 *   movie / tv   -> TMDB v3 API with the read bearer token (config.tmdbBearer)
 *
 * "popular" (the default) means what people are watching NOW, in the user's country:
 *   - movies: recent releases (last ~5 months) in that region, most popular first;
 *   - TV: series that started recently and are airing now, most popular first, once
 *     worldwide and once restricted to the country's own language (TMDB has no per-country
 *     TV popularity, so "made in that country" is the closest honest signal);
 *   - anime: AniList trending (there is no country dimension).
 * "top_rated" is only for an explicit "best ever" question.
 *
 * Only short structured fields go back to the model (title, year, score, genres): no free text
 * from the sources, so a hostile synopsis can never become an instruction. Adult titles are
 * excluded at the source. Results are cached, so the sources see a handful of requests per
 * half hour however many users ask.
 */
const axios = require("axios");
const config = require("./config");

const ANILIST_URL = "https://graphql.anilist.co";
const TMDB_URL = "https://api.themoviedb.org/3";
const TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_TITLE_CHARS = 120;

const cache = new Map(); // "category|kind|count|genre|region|lang" -> { exp, value }

const KINDS = ["popular", "trending", "top_rated"];
const CATEGORIES = ["anime", "movie", "tv"];

// app locale -> TMDB `language` (titles come back in this language when TMDB has them)
const TMDB_LANGUAGE = {
  en: "en-US", ko: "ko-KR", ja: "ja-JP", zh: "zh-CN", "zh-tw": "zh-TW", tw: "zh-TW",
  id: "id-ID", ms: "ms-MY", ru: "ru-RU", th: "th-TH", vi: "vi-VN",
};

// Where the user is: cf-ipcountry when it is a real country, else a guess from the chat language.
const LANGUAGE_REGION = {
  ko: "KR", ja: "JP", zh: "CN", "zh-tw": "TW", tw: "TW", id: "ID", ms: "MY", ru: "RU", th: "TH", vi: "VN", en: "US",
};
// country -> original language of its own productions (English-speaking countries: none, the
// worldwide list already is their local one)
const COUNTRY_LANGUAGE = {
  KR: "ko", JP: "ja", CN: "zh", TW: "zh", HK: "zh", TH: "th", ID: "id", MY: "ms", VN: "vi", RU: "ru",
};

// genre names the model may use -> TMDB genre ids (TV has fewer, merged genres)
const MOVIE_GENRE_IDS = {
  Action: 28, Adventure: 12, Animation: 16, Comedy: 35, Crime: 80, Documentary: 99, Drama: 18, Family: 10751,
  Fantasy: 14, History: 36, Horror: 27, Music: 10402, Mystery: 9648, Romance: 10749, "Science Fiction": 878,
  Thriller: 53, War: 10752, Western: 37,
};
const TV_GENRE_IDS = {
  Action: 10759, Adventure: 10759, Animation: 16, Comedy: 35, Crime: 80, Documentary: 99, Drama: 18, Family: 10751,
  Fantasy: 10765, Mystery: 9648, Romance: 18, "Science Fiction": 10765, Thriller: 9648, War: 10768, Western: 37,
};
const ANIME_GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music", "Mystery",
  "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller",
];
const GENRES = [...new Set([...Object.keys(MOVIE_GENRE_IDS), ...ANIME_GENRES])];

// TMDB genre ids (movie + tv) -> English names in results; the model translates to the chat language
const TMDB_GENRE_NAMES = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary",
  18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
  9648: "Mystery", 10749: "Romance", 878: "Science Fiction", 10770: "TV Movie", 53: "Thriller",
  10752: "War", 37: "Western", 10759: "Action & Adventure", 10762: "Kids", 10765: "Sci-Fi & Fantasy",
  10768: "War & Politics",
};

const ANILIST_QUERY = `
query ($perPage: Int, $sort: [MediaSort], $genre: String) {
  Page(page: 1, perPage: $perPage) {
    media(type: ANIME, isAdult: false, sort: $sort, format_in: [TV, MOVIE, ONA], genre: $genre, genre_not_in: ["Ecchi"]) {
      title { romaji english native }
      seasonYear
      averageScore
      genres
      format
    }
  }
}`;
// AniList has no country dimension and its all-time "popularity" is not "latest": current
// popularity is TRENDING.
const ANILIST_SORT = { popular: "TRENDING_DESC", trending: "TRENDING_DESC", top_rated: "SCORE_DESC" };

const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

// Only plain, short text goes to the model.
function clean(text) {
  return String(text || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_CHARS);
}

/** ISO country code to use: the model's explicit choice, else cf-ipcountry, else from the language. */
function resolveRegion(explicit, country, lang) {
  const valid = (c) => /^[A-Za-z]{2}$/.test(String(c || "")) && !["XX", "T1"].includes(String(c).toUpperCase());
  if (valid(explicit)) return String(explicit).toUpperCase();
  if (valid(country)) return String(country).toUpperCase();
  return LANGUAGE_REGION[String(lang || "").toLowerCase()] || "US";
}

async function anilist(kind, count, genre) {
  const resp = await axios.post(
    ANILIST_URL,
    { query: ANILIST_QUERY, variables: { perPage: count, sort: [ANILIST_SORT[kind]], genre: genre || null } },
    { timeout: TIMEOUT_MS, headers: { "Content-Type": "application/json", Accept: "application/json" } }
  );
  const media = resp.data && resp.data.data && resp.data.data.Page && resp.data.data.Page.media;
  if (!Array.isArray(media)) throw new Error("unexpected AniList response");
  const items = media.map((m) => ({
    title: clean((m.title && (m.title.english || m.title.romaji)) || ""),
    original_title: clean(m.title && m.title.native),
    year: m.seasonYear || null,
    score: m.averageScore ? Math.round(m.averageScore) / 10 : null, // 0-100 -> 0-10
    genres: (m.genres || []).slice(0, 4).map(clean),
    format: clean(m.format),
  }));
  await Promise.all(items.map(attachTmdbId));
  return items;
}

/**
 * Many anime are on TMDB too: find the TMDB page of an AniList title (Japanese original title
 * first, then the English / romaji one; same year +-1; a film for MOVIE, else a series).
 * No match, or TMDB unreachable: the item just has no id and the app falls back to a name search.
 */
async function attachTmdbId(item) {
  const type = item.format === "MOVIE" ? "movie" : "tv";
  const tries = [
    [item.original_title, "ja"],
    [item.title, "en"],
  ];
  for (const [name, lang] of tries) {
    if (!name) continue;
    try {
      const hit = await findTmdbTitle(name, { year: item.year, type, lang });
      if (hit) {
        item.tmdb_id = hit.id;
        item.tmdb_type = hit.type;
        return;
      }
    } catch (error) {
      return; // TMDB down or no key: leave it without an id
    }
  }
}

function tmdbItems(results, count, genreId) {
  return results
    .filter((r) => !r.adult && (!genreId || (r.genre_ids || []).includes(genreId)))
    .slice(0, count)
    .map((r) => ({
      title: clean(r.title || r.name),
      original_title: clean(r.original_title || r.original_name),
      year: parseInt(String(r.release_date || r.first_air_date || "").slice(0, 4), 10) || null,
      score: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
      genres: (r.genre_ids || []).map((id) => TMDB_GENRE_NAMES[id]).filter(Boolean).slice(0, 4),
      // kept on the server only (tools.js strips them before the model sees the list): they let
      // the app open the title's page directly instead of searching for it by name
      tmdb_id: r.id || null,
      tmdb_type: r.media_type || (r.title !== undefined ? "movie" : "tv"),
    }));
}

async function tmdbGet(path, params, lang) {
  if (!config.tmdbBearer) throw new Error("TMDB_API_BEARER is not set");
  const resp = await axios.get(`${TMDB_URL}${path}`, {
    timeout: TIMEOUT_MS,
    headers: { Authorization: `Bearer ${config.tmdbBearer}`, Accept: "application/json" },
    params: { language: TMDB_LANGUAGE[lang] || "en-US", include_adult: false, page: 1, ...params },
  });
  const results = resp.data && resp.data.results;
  if (!Array.isArray(results)) throw new Error("unexpected TMDB response");
  return results;
}

const norm = (t) => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const searchCache = new Map(); // "lang|title" -> { exp, results }

/**
 * Is this a movie or TV series TMDB knows (i.e. something the app can open a detail page for)?
 * A hit needs the same title (title / original title, punctuation and case ignored) and, when a
 * year is given, a release year within one year. Returns {type, year, id} or null. Throws when TMDB
 * can't be reached (the caller then shows no link).
 */
async function findTmdbTitle(title, { year = null, type = null, lang = "en" } = {}) {
  const wanted = norm(title);
  if (!wanted) return null;
  const key = `${lang}|${wanted}`;
  let entry = searchCache.get(key);
  if (!entry || entry.exp < Date.now()) {
    const results = await tmdbGet("/search/multi", { query: title }, lang);
    entry = { exp: Date.now() + 24 * 60 * 60 * 1000, results };
    if (searchCache.size > 2000) searchCache.clear();
    searchCache.set(key, entry);
  }
  for (const r of entry.results) {
    if (r.media_type !== "movie" && r.media_type !== "tv") continue;
    if (type && r.media_type !== type) continue;
    const names = [r.title, r.name, r.original_title, r.original_name].map(norm);
    if (!names.includes(wanted)) continue;
    const y = parseInt(String(r.release_date || r.first_air_date || "").slice(0, 4), 10) || null;
    if (year && y && Math.abs(y - year) > 1) continue;
    return { type: r.media_type, year: y, id: r.id || null };
  }
  return null;
}

/** movie / tv charts. Returns { items, local_items? }. */
async function tmdb(category, kind, count, lang, region, genre) {
  const genreId = (category === "movie" ? MOVIE_GENRE_IDS : TV_GENRE_IDS)[genre];
  const withGenre = genreId ? { with_genres: genreId } : {};

  if (kind === "trending") {
    // TMDB's trending endpoints take no genre filter: fetch the page and filter here
    const results = await tmdbGet(`/trending/${category}/week`, {}, lang);
    return { items: tmdbItems(results, count, genreId) };
  }

  if (kind === "top_rated") {
    // /discover with a vote floor: TMDB's own /top_rated list is topped by brand-new titles
    // with a handful of votes, which is not what "highest rated ever" means.
    const results = await tmdbGet(
      `/discover/${category}`,
      { sort_by: "vote_average.desc", "vote_count.gte": category === "movie" ? 5000 : 2000, ...withGenre },
      lang
    );
    return { items: tmdbItems(results, count) };
  }

  if (category === "movie") {
    // recent releases in the user's region (re-releases of old films are cut by the 2-year floor)
    const results = await tmdbGet(
      "/discover/movie",
      {
        region,
        sort_by: "popularity.desc",
        "release_date.gte": day(-150),
        "release_date.lte": day(0),
        "primary_release_date.gte": day(-730),
        with_release_type: "2|3",
        ...withGenre,
      },
      lang
    );
    return { items: tmdbItems(results, count) };
  }

  // tv, popular now: recently started series that are airing now
  const window = { sort_by: "popularity.desc", "first_air_date.gte": day(-540), "air_date.gte": day(-60), ...withGenre };
  const localLanguage = COUNTRY_LANGUAGE[region];
  const [worldwide, local] = await Promise.all([
    tmdbGet("/discover/tv", window, lang),
    localLanguage ? tmdbGet("/discover/tv", { ...window, with_original_language: localLanguage }, lang) : Promise.resolve(null),
  ]);
  return { items: tmdbItems(worldwide, count), ...(local ? { local_items: tmdbItems(local, count) } : {}) };
}

/**
 * @param {{category: "anime"|"movie"|"tv", kind?: "popular"|"trending"|"top_rated", count?: number,
 *          genre?: string, region?: string}} args
 * @param {{lang?: string, country?: string}} context  chat language (app locale) and the user's
 *          country (cf-ipcountry)
 * @returns {Promise<{source: string, category: string, kind: string, region: string, items: object[], local_items?: object[]}>}
 */
async function getPopularTitles(args, { lang = "en", country = "" } = {}) {
  const category = CATEGORIES.includes(args && args.category) ? args.category : null;
  if (!category) throw new Error("category must be anime, movie or tv");
  const kind = KINDS.includes(args.kind) ? args.kind : "popular";
  const count = Math.min(Math.max(parseInt(args.count, 10) || 5, 1), 10);
  const region = resolveRegion(args.region, country, lang);

  // a genre the source doesn't have is ignored (and reported), not an error
  const known = category === "anime" ? ANIME_GENRES.includes(args.genre) : Boolean((category === "movie" ? MOVIE_GENRE_IDS : TV_GENRE_IDS)[args.genre]);
  const genre = known ? args.genre : null;

  const key = [category, kind, count, genre || "-", category === "anime" ? "-" : region, category === "anime" ? "-" : lang].join("|");
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;

  const data = category === "anime" ? { items: await anilist(kind, count, genre) } : await tmdb(category, kind, count, lang, region, genre);
  const value = {
    source: category === "anime" ? "AniList" : "TMDB",
    category,
    kind,
    ...(category === "anime" ? {} : { region }),
    ...(genre ? { genre } : {}),
    ...(args.genre && !genre ? { genre_ignored: args.genre } : {}),
    ...data,
  };
  if (data.items.length || (data.local_items && data.local_items.length)) cache.set(key, { exp: Date.now() + CACHE_TTL_MS, value });
  return value;
}

// ---------------------------------------------------------------------------------------------
// Flix1's own catalogue (imdb7plus, the M API): random popular titles of a country, all of them
// playable in the app. Random on every call (Mongo $sample), so asking twice gives different
// suggestions; hence never cached.

const LOOKUP_URL = "https://apiplayer.app/api/lookup";
const M_API_ALIAS = "imdb7.plus"; // the alias the apps use; lookup says which real domain it is today
const M_API_FALLBACK_HOST = "flix1.net";
const M_HOST_TTL_MS = 30 * 60 * 1000;
let mHost = { value: null, exp: 0 };

// The API's `country` is a case-insensitive regex over the production-country names stored with
// each title, so it needs the English NAMES (an ISO code like "KR" would match "Ukraine"), with
// word boundaries ("UK" would match "Ukraine" too). Unlisted countries fall back to worldwide.
const COUNTRY_NAMES = {
  KR: "South Korea", JP: "Japan", CN: "China", HK: "Hong Kong", TW: "Taiwan", TH: "Thailand", ID: "Indonesia",
  MY: "Malaysia", VN: "Vietnam", PH: "Philippines", SG: "Singapore", IN: "India", RU: "Russia", TR: "Turkey",
  US: "United States|USA", GB: "United Kingdom|UK", FR: "France", DE: "Germany", IT: "Italy", ES: "Spain",
  CA: "Canada", AU: "Australia", MX: "Mexico", BR: "Brazil", AR: "Argentina", SE: "Sweden", DK: "Denmark",
  NL: "Netherlands", PL: "Poland", UA: "Ukraine", IE: "Ireland", NZ: "New Zealand",
};
const M_CATEGORY = { movie: "movie", tv: "series" };

// chat language -> the title languages the catalogue stores (ko, en, ja, zh ...), best first
const TITLE_LANGUAGES = {
  ko: ["ko"], ja: ["ja"], zh: ["zh"], "zh-tw": ["tw", "zh"], tw: ["tw", "zh"],
  id: ["id"], ms: ["ms"], ru: ["ru"], th: ["th"], vi: ["vi"], en: [],
};

async function resolveMApiHost() {
  if (mHost.value && mHost.exp > Date.now()) return mHost.value;
  try {
    const resp = await axios.get(LOOKUP_URL, { timeout: TIMEOUT_MS });
    const host = resp.data && resp.data.map && resp.data.map[M_API_ALIAS];
    if (typeof host === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
      mHost = { value: host, exp: Date.now() + M_HOST_TTL_MS };
      return host;
    }
  } catch (error) {
    console.log("[catalog] lookup failed:", error.message);
  }
  // keep using the last known host, else the default; try lookup again soon
  mHost = { value: mHost.value || M_API_FALLBACK_HOST, exp: Date.now() + 60 * 1000 };
  return mHost.value;
}

function pickTitle(displayNames, lang) {
  const byLang = {};
  for (const t of Array.isArray(displayNames) ? displayNames : []) {
    if (t && t.language && t.title) byLang[String(t.language).toLowerCase()] = t.title;
  }
  for (const code of TITLE_LANGUAGES[lang] || []) {
    // the catalogue copies the Korean title into languages it has no translation for
    if (byLang[code] && (code === "ko" || byLang[code] !== byLang.ko)) return clean(byLang[code]);
  }
  return clean(byLang.en || byLang.ko || Object.values(byLang)[0] || "");
}

/**
 * @param {{category?: "movie"|"tv", count?: number, region?: string}} args
 * @param {{lang?: string, country?: string}} context
 * @returns {Promise<{source: string, region: string, items: object[]}>}
 */
async function getCatalogPicks(args = {}, { lang = "en", country = "" } = {}) {
  const count = Math.min(Math.max(parseInt(args.count, 10) || 5, 1), 10);
  const region = resolveRegion(args.region, country, lang);
  // The catalogue holds movies and TV series only (no animation entries at the moment): anime
  // recommendations come from the AniList chart, so don't waste a request here.
  if (args.category === "anime") return { source: "Flix1 catalogue", region, items: [], note: "the catalogue has no anime; use get_popular_titles for anime" };
  const names = COUNTRY_NAMES[region];
  const host = await resolveMApiHost();

  const params = { most_popular: true, size: count };
  if (names) params.country = `\\b(${names})\\b`;
  if (M_CATEGORY[args.category]) params.category = M_CATEGORY[args.category];

  const resp = await axios.get(`https://${host}/swm/movie/random-list`, { params, timeout: TIMEOUT_MS });
  const data = resp.data && resp.data.data;
  if (!Array.isArray(data)) throw new Error("unexpected catalogue response");

  const items = data.map((m) => ({
    title: pickTitle(m.title_display_name, String(lang).toLowerCase()),
    year: m.startyear || null,
    score: m.imdb_score ? Math.round(m.imdb_score * 10) / 10 : null,
    type: m.category === "series" ? "tv" : m.category === "animation" ? "animation" : "movie",
    imdb_id: /^tt\d+$/.test(String(m.imdb_id || "")) ? m.imdb_id : null, // server only, see tools.js
    genres: (Array.isArray(m.genre) ? m.genre : []).slice(0, 4).map(clean),
    made_in: clean(m.countries),
    playable_in_app: true,
  })).filter((i) => i.title);
  return { source: "Flix1 catalogue", region, ...(names ? {} : { note: "not filtered by country: worldwide" }), items };
}

const _clearCache = () => {
  cache.clear();
  searchCache.clear();
  mHost = { value: null, exp: 0 };
};

module.exports = { findTmdbTitle, getPopularTitles, getCatalogPicks, resolveRegion, clean, _clearCache, CATEGORIES, KINDS, GENRES, COUNTRY_NAMES };
