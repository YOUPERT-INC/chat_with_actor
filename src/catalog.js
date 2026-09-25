/**
 * Live movie / TV / anime lists for recommendations. The only source is TMDB (v3 API, read bearer
 * token in config.tmdbBearer): every recommendation is a TMDB list asked with TMDB parameters
 * (category, genre, country, year, rating ...), never a title search. The ids of the returned
 * titles go to the app as link data (see tools.js), so the app opens the detail page by id.
 *
 * kind:
 *   popular   -> what people watch NOW: movies released in the last ~5 months, TV series that
 *                started in the last ~18 months and are airing now, most popular first;
 *   trending  -> TMDB's weekly trending list (worldwide, unfiltered);
 *   top_rated -> best rated of all time, with a vote floor so brand-new titles with a handful of
 *                votes do not top the list.
 * scope:
 *   global    -> no country filter;
 *   country   -> titles MADE in one country (with_origin_country): TMDB has no per-country
 *                viewing charts, "made there" is the closest honest signal.
 * anime is TMDB's Japanese-language animation series (movies: category=movie, genre=Animation,
 * region=JP).
 *
 * Only short structured fields go back to the model (title, year, score, genres): no free text
 * from TMDB, so a hostile synopsis can never become an instruction. Adult titles are excluded at
 * the source. Results are cached, so TMDB sees a handful of requests per half hour however many
 * users ask.
 */
const axios = require("axios");
const config = require("./config");

const TMDB_URL = "https://api.themoviedb.org/3";
const TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_TITLE_CHARS = 120;

const cache = new Map(); // request key -> { exp, value }

const KINDS = ["popular", "trending", "top_rated"];
const SCOPES = ["global", "country"];
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
const GENRES = Object.keys(MOVIE_GENRE_IDS);

// TMDB genre ids (movie + tv) -> English names in results; the model translates to the chat language
const TMDB_GENRE_NAMES = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary",
  18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
  9648: "Mystery", 10749: "Romance", 878: "Science Fiction", 10770: "TV Movie", 53: "Thriller",
  10752: "War", 37: "Western", 10759: "Action & Adventure", 10762: "Kids", 10765: "Sci-Fi & Fantasy",
  10768: "War & Politics",
};

// Vote floors: without them TMDB's rating sort is topped by titles with a handful of votes.
const TOP_RATED_VOTES = { global: { movie: 5000, tv: 2000 }, country: { movie: 500, tv: 200 } };
const MIN_RATING_VOTES = { movie: 300, tv: 100 };

const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

// Only plain, short text goes to the model.
function clean(text) {
  return String(text || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_CHARS);
}

const validCountry = (c) => /^[A-Za-z]{2}$/.test(String(c || "")) && !["XX", "T1"].includes(String(c).toUpperCase());

/** ISO country code to use: the model's explicit choice, else cf-ipcountry, else from the language. */
function resolveRegion(explicit, country, lang) {
  if (validCountry(explicit)) return String(explicit).toUpperCase();
  if (validCountry(country)) return String(country).toUpperCase();
  return LANGUAGE_REGION[String(lang || "").toLowerCase()] || "US";
}

function tmdbItems(results, count, genreIds = []) {
  return results
    .filter((r) => !r.adult && genreIds.every((id) => (r.genre_ids || []).includes(id)))
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

const intOrNull = (v, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

/**
 * Turns the model's arguments into one normalised, validated request. Anything TMDB cannot
 * express is dropped (and, for genres, reported) instead of failing the whole call.
 */
function normalizeArgs(args, { lang = "en", country = "" } = {}) {
  const a = args || {};
  const category = CATEGORIES.includes(a.category) ? a.category : null;
  if (!category) throw new Error("category must be anime, movie or tv");
  const kind = KINDS.includes(a.kind) ? a.kind : "popular";
  const count = Math.min(Math.max(parseInt(a.count, 10) || 5, 1), 10);

  // a given region means "made in that country" even when the model forgot scope=country
  const scope = a.scope === "country" || (a.scope !== "global" && validCountry(a.region)) ? "country" : "global";
  const region = scope === "country" ? resolveRegion(a.region, country, lang) : null;

  const wanted = [...(Array.isArray(a.genres) ? a.genres : []), ...(a.genre ? [a.genre] : [])].slice(0, 2);
  const ids = category === "movie" ? MOVIE_GENRE_IDS : TV_GENRE_IDS;
  const genres = wanted.filter((g) => ids[g]);
  const genreIgnored = wanted.filter((g) => !ids[g]);

  let yearFrom = intOrNull(a.year_from, 1900, 2100);
  let yearTo = intOrNull(a.year_to, 1900, 2100);
  if (yearFrom && yearTo && yearFrom > yearTo) [yearFrom, yearTo] = [yearTo, yearFrom];
  const rating = Number(a.min_rating);
  const minRating = Number.isFinite(rating) && rating > 0 && rating <= 10 ? Math.round(rating * 10) / 10 : null;
  const maxRuntime = category === "movie" ? intOrNull(a.max_runtime, 30, 400) : null;
  const language = /^[a-z]{2}$/.test(String(a.original_language || "")) ? a.original_language : null;

  return { category, kind, count, scope, region, genres, genreIgnored, yearFrom, yearTo, minRating, maxRuntime, language };
}

/** TMDB /discover parameters for a normalised request. `wide` widens the "recent" window. */
function discoverParams(q, { wide = false } = {}) {
  const isMovie = q.category === "movie";
  const tvLike = !isMovie; // tv and anime
  const genreIds = [...new Set(q.genres.map((g) => (isMovie ? MOVIE_GENRE_IDS : TV_GENRE_IDS)[g]))];
  if (q.category === "anime" && !genreIds.includes(16)) genreIds.unshift(16); // Animation
  const p = {};
  if (genreIds.length) p.with_genres = genreIds.join(","); // comma = all of them
  if (q.scope === "country") p.with_origin_country = q.region;
  if (q.category === "anime") p.with_original_language = "ja";
  else if (q.language) p.with_original_language = q.language;
  if (q.maxRuntime) p["with_runtime.lte"] = q.maxRuntime;

  const fromKey = isMovie ? "primary_release_date.gte" : "first_air_date.gte";
  const toKey = isMovie ? "primary_release_date.lte" : "first_air_date.lte";
  const hasYears = q.yearFrom || q.yearTo;
  if (q.yearFrom) p[fromKey] = `${q.yearFrom}-01-01`;
  if (q.yearTo) p[toKey] = `${q.yearTo}-12-31`;

  if (q.kind === "top_rated") {
    p.sort_by = "vote_average.desc";
    p["vote_count.gte"] = TOP_RATED_VOTES[q.scope][isMovie ? "movie" : "tv"];
  } else {
    p.sort_by = "popularity.desc";
    if (!hasYears) {
      // popular = what people watch now: recent releases; the wide window is the fallback for
      // countries with few recent titles
      if (isMovie) {
        p[fromKey] = day(wide ? -730 : -150);
        p[toKey] = day(0);
      } else {
        p[fromKey] = day(wide ? -1460 : -540);
        p["air_date.gte"] = day(wide ? -365 : -60);
      }
    }
  }
  if (q.minRating) {
    p["vote_average.gte"] = q.minRating;
    p["vote_count.gte"] = Math.max(p["vote_count.gte"] || 0, MIN_RATING_VOTES[isMovie ? "movie" : "tv"]);
  }
  return p;
}

async function fetchItems(q, lang) {
  const isMovie = q.category === "movie";
  const path = isMovie ? "/discover/movie" : "/discover/tv";
  const plain = q.scope === "global" && !q.yearFrom && !q.yearTo && !q.minRating && !q.maxRuntime && !q.language && q.category !== "anime";

  if (q.kind === "trending" && plain) {
    // TMDB's trending endpoints take no filter: fetch the page and filter genres here
    const ids = q.genres.map((g) => (isMovie ? MOVIE_GENRE_IDS : TV_GENRE_IDS)[g]);
    const results = await tmdbGet(`/trending/${isMovie ? "movie" : "tv"}/week`, {}, lang);
    return tmdbItems(results, q.count, ids);
  }

  let items = tmdbItems(await tmdbGet(path, discoverParams(q), lang), q.count);
  const canWiden = q.kind !== "top_rated" && !q.yearFrom && !q.yearTo;
  if (items.length < q.count && canWiden) {
    items = tmdbItems(await tmdbGet(path, discoverParams(q, { wide: true }), lang), q.count);
  }
  return items;
}

/**
 * @param {{category: "anime"|"movie"|"tv", kind?: "popular"|"trending"|"top_rated", scope?: "global"|"country",
 *          region?: string, genre?: string, genres?: string[], year_from?: number, year_to?: number,
 *          min_rating?: number, max_runtime?: number, original_language?: string, count?: number}} args
 * @param {{lang?: string, country?: string}} context  chat language (app locale) and the user's
 *          country (cf-ipcountry)
 * @returns {Promise<{source: string, category: string, kind: string, scope: string, region?: string, items: object[]}>}
 */
async function getTitles(args, { lang = "en", country = "" } = {}) {
  const q = normalizeArgs(args, { lang, country });
  const key = JSON.stringify([q.category, q.kind, q.count, q.scope, q.region, q.genres, q.yearFrom, q.yearTo, q.minRating, q.maxRuntime, q.language, lang]);
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;

  const items = await fetchItems(q, lang);
  const value = {
    source: "TMDB",
    category: q.category,
    kind: q.kind,
    scope: q.scope,
    ...(q.region ? { region: q.region } : {}),
    ...(q.genres.length ? { genre: q.genres.join(", ") } : {}),
    ...(q.genreIgnored.length ? { genre_ignored: q.genreIgnored.join(", ") } : {}),
    items,
  };
  if (items.length) cache.set(key, { exp: Date.now() + CACHE_TTL_MS, value });
  return value;
}

const _clearCache = () => cache.clear();

module.exports = { getTitles, resolveRegion, clean, _clearCache, CATEGORIES, KINDS, SCOPES, GENRES };
