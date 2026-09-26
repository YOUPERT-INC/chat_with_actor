/**
 * Tools the avatar may call while chatting (OpenAI-style function calling, supported by
 * DeepSeek). Recommendations: get_titles asks TMDB for a list by category, genre, country, year
 * and rating parameters, so answers come from real data instead of the model's older memory.
 */
const catalog = require("./catalog");
const humor = require("./humor");

const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "get_titles",
      description:
        "Live lists of movies, TV series or anime from TMDB. Every recommendation of a movie, series or anime MUST " +
        "come from this tool, never from memory. Turn what the user asks for into parameters: " +
        "kind=popular (default) is what people watch right now (recent releases); kind=trending is hot this week; " +
        "kind=top_rated is the best rated of all time (use it when they ask for the best / highest rated / a classic). " +
        "'genres' filters by genre (up to 2, all must match), 'year_from' / 'year_to' by release year (a decade, 'from the 90s'), " +
        "'min_rating' by score (0-10), 'max_runtime' by length in minutes (movies), 'original_language' by spoken language (ISO 639-1). " +
        "'scope' says where the titles come from: global = worldwide (no country filter); country = titles MADE in one " +
        "country ('region', an ISO code; leave it empty for the user's own country). If the user does not name a country, " +
        "call the tool twice at once, scope=global and scope=country, with the same other parameters. If the user names a country, " +
        "make one call with scope=country and that region. Anime means Japanese animation series; anime films are " +
        "category=movie, genres=[Animation], region=JP. Several calls at once are fine. " +
        "Do not use it for casual chat, or for a specific title you already know about.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: catalog.CATEGORIES },
          kind: { type: "string", enum: catalog.KINDS, description: "popular (default) = watched now; trending = hot this week; top_rated = best of all time" },
          scope: { type: "string", enum: catalog.SCOPES, description: "global = worldwide; country = made in `region` (default: the user's country)" },
          region: { type: "string", description: "ISO country code for scope=country. ONLY when the user names a country (e.g. JP, KR, CN) or for your own country. NEVER guess the user's country from their language: leave it out and the server uses the user's real country" },
          genres: { type: "array", items: { type: "string", enum: catalog.GENRES }, maxItems: 2, description: "optional: genres that all must match" },
          year_from: { type: "integer", description: "optional: released in or after this year" },
          year_to: { type: "integer", description: "optional: released in or before this year" },
          min_rating: { type: "number", minimum: 0, maximum: 10, description: "optional: minimum TMDB score" },
          max_runtime: { type: "integer", description: "optional: movies only, at most this many minutes" },
          original_language: { type: "string", description: "optional: ISO 639-1 code of the original language (e.g. ko, ja, zh)" },
          count: { type: "integer", minimum: 1, maximum: 10, description: "how many titles (default 5)" },
        },
        required: ["category"],
      },
    },
  },
];

// Only offered to Korean-language users (the posts are Korean); see toolDefsFor().
const FUNNY_TOOL = {
  type: "function",
  function: {
    name: "get_funny_post",
    description:
      "Pick ONE currently popular funny post from a Korean online community to share with the user; the app adds the link " +
      "to your message by itself. Use it only when the user says they are bored, asks for something funny or entertaining, " +
      "or asks what is trending in Korean communities. Never use it unprompted or for other kinds of requests.",
    parameters: { type: "object", properties: {} },
  },
};

/** Tool definitions for this request: the always-on ones, plus the funny-post tool for Korean users. */
function toolDefsFor(context = {}) {
  return humor.isEligible(context.lang) ? [...TOOL_DEFS, FUNNY_TOOL] : TOOL_DEFS;
}

const PAGE_SIZE = 20; // one TMDB page
const MAX_PAGES = 3;
const titleKey = (item) => `${item.tmdb_type || "movie"}:${item.tmdb_id}`;

/**
 * get_titles without repeats: titles already recommended in this conversation
 * (`context.recommended`, keys "movie:123") and titles another call of the same turn already
 * returned are skipped, and later TMDB pages are read until enough new ones are found. The pages
 * are cached and shared by all users; only this skipping is per conversation.
 */
async function getFreshTitles(args, context) {
  const want = Math.min(Math.max(parseInt(args && args.count, 10) || 5, 1), 10);
  const seen = context.recommended instanceof Set ? context.recommended : new Set();
  const thisTurn = context.shownThisTurn || (context.shownThisTurn = new Set());

  let first = null;
  let skipped = 0;
  const items = [];
  for (let page = 1; page <= MAX_PAGES && items.length < want; page++) {
    const r = await catalog.getTitles({ ...args, count: PAGE_SIZE, page }, context);
    first = first || r;
    for (const item of r.items || []) {
      if (items.length >= want) break;
      const key = item && item.tmdb_id ? titleKey(item) : null;
      if (key && (seen.has(key) || thisTurn.has(key))) {
        skipped++;
        continue;
      }
      if (key) thisTurn.add(key);
      items.push(item);
    }
    if ((r.items || []).length < PAGE_SIZE) break; // that was the last page
  }
  return {
    ...first,
    items,
    ...(skipped ? { note: "Titles already recommended in this chat were left out; these are all new." } : {}),
  };
}

const RUNNERS = {
  get_funny_post: (args, context) => humor.pickForContext(context),
  get_titles: (args, context) => getFreshTitles(args, context),
};

// Ids stay on the server (they go to the app as link data); the model only needs title, year, score.
const stripIds = (item) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const { tmdb_id, tmdb_type, imdb_id, ...rest } = item;
  return rest;
};
function withoutIds(result) {
  if (!result || typeof result !== "object") return result;
  const out = { ...result };
  if (Array.isArray(result.items)) out.items = result.items.map(stripIds);
  return out;
}

/**
 * Runs one tool call for the model. Never throws: a failure becomes an `unavailable` result,
 * so the model answers from what it knows instead of the user seeing an error.
 * @param {string} name
 * @param {string|object} rawArgs  JSON string as sent by the model, or an object
 * @param {{lang?: string, country?: string}} context
 */
async function runTool(name, rawArgs, context = {}) {
  const started = Date.now();
  try {
    const args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : rawArgs || {};
    const run = RUNNERS[name];
    if (!run) return { error: "unknown tool" };
    const result = await run(args, context);
    const n = (result.items || []).length;
    const shown = withoutIds(result);
    if (Array.isArray(context.knownTitles)) {
      const type = result.category === "movie" || result.category === "tv" ? result.category : null;
      for (const item of result.items || []) {
        if (item && item.title) context.knownTitles.push({ ...item, type: item.tmdb_type || item.type || type });
      }
    }
    console.log(`[tool] ${name} ${JSON.stringify(args)} scope=${result.scope || "-"} region=${result.region || "-"} -> ${n} items ${Date.now() - started}ms`);
    return shown;
  } catch (error) {
    console.log(`[tool] ${name} failed after ${Date.now() - started}ms: ${error.message}`);
    return { error: "unavailable", note: "The live chart could not be reached; answer from what you know and say it may be out of date." };
  }
}

module.exports = { TOOL_DEFS, FUNNY_TOOL, toolDefsFor, runTool };
