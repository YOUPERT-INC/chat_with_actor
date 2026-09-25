/**
 * Tools the avatar may call while chatting (OpenAI-style function calling, supported by
 * DeepSeek). Right now one: live popularity charts, so "what is popular now?" is answered
 * from real data (for the user's own country) instead of the model's older memory.
 */
const catalog = require("./catalog");
const humor = require("./humor");

const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "get_popular_titles",
      description:
        "Look up live charts of anime, movies or TV series. By default (kind=popular) it returns what is popular " +
        "RIGHT NOW in the user's own country (movies: recent releases there; TV: new and currently airing series, " +
        "'items' worldwide and 'local_items' made in the user's country's language; anime: currently trending). " +
        "Use it when the user asks what to watch, for recommendations, what is popular or trending, or for a ranking. " +
        "Use kind=top_rated ONLY when the user explicitly asks for the best of all time. " +
        "Pass 'genre' to get the popular titles of one genre, for example to answer as your character from the genres " +
        "you love; several calls at once (one per genre or category) are fine. " +
        "Do not use it for casual chat, or for a specific title you already know about.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: catalog.CATEGORIES },
          kind: {
            type: "string",
            enum: catalog.KINDS,
            description: "popular = popular now in the user's country (default); trending = hot this week worldwide; top_rated = best of all time",
          },
          genre: { type: "string", enum: catalog.GENRES, description: "optional: only this genre" },
          count: { type: "integer", minimum: 1, maximum: 10, description: "how many titles (default 5)" },
          region: { type: "string", description: "optional ISO country code, only if the user asks about another country (e.g. JP)" },
        },
        required: ["category"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_catalog_picks",
      description:
        "Get random popular titles of the user's country from Flix1's own catalogue, all of which can be watched right " +
        "in this app. The picks are different on every call, so use it together with get_popular_titles whenever you " +
        "recommend movies or TV series, and mix a couple of them in: suggestions stay fresh instead of repeating " +
        "the same titles, and the user can start watching immediately. Do not use it for casual chat.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["movie", "tv"], description: "optional: only movies or only tv series (the catalogue has no anime)" },
          count: { type: "integer", minimum: 1, maximum: 10, description: "how many titles (default 5)" },
          region: { type: "string", description: "optional ISO country code, only if the user asks about another country" },
        },
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

const RUNNERS = {
  get_funny_post: (args, context) => humor.pickForContext(context),
  get_popular_titles: (args, context) => catalog.getPopularTitles(args, context),
  get_catalog_picks: (args, context) => catalog.getCatalogPicks(args, context),
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
  if (Array.isArray(result.local_items)) out.local_items = result.local_items.map(stripIds);
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
    const n = (result.items || []).length + (result.local_items ? result.local_items.length : 0);
    const shown = withoutIds(result);
    if (Array.isArray(context.knownTitles)) {
      const type = result.category === "movie" || result.category === "tv" ? result.category : null;
      for (const item of [...(result.items || []), ...(result.local_items || [])]) {
        if (item && item.title) context.knownTitles.push({ ...item, type: item.tmdb_type || item.type || type });
      }
    }
    console.log(`[tool] ${name} ${JSON.stringify(args)} region=${result.region || "-"} -> ${n} items ${Date.now() - started}ms`);
    return shown;
  } catch (error) {
    console.log(`[tool] ${name} failed after ${Date.now() - started}ms: ${error.message}`);
    return { error: "unavailable", note: "The live chart could not be reached; answer from what you know and say it may be out of date." };
  }
}

module.exports = { TOOL_DEFS, FUNNY_TOOL, toolDefsFor, runTool };
