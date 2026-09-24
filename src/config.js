require("dotenv").config();

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

module.exports = {
  port: int(process.env.PORT, 8004),
  mongoUri: process.env.MONGODB_URI || "",
  mongoDb: process.env.MONGODB_DB || "swipexdevdb",
  deepseekKey: process.env.DEEPSEEK_API_KEY || "",
  deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-flash",
  deepseekUrl: "https://api.deepseek.com/chat/completions",
  dailyMessageLimit: int(process.env.DAILY_MESSAGE_LIMIT, 200),
  maxInputChars: int(process.env.MAX_INPUT_CHARS, 1000),
  historyMessages: int(process.env.HISTORY_MESSAGES, 30),
  // chat is limited to actresses whose Korean description is long enough to build a persona
  minDescriptionChars: int(process.env.MIN_DESCRIPTION_CHARS, 300),
  // live chart lookups for recommendations (tmdb: same bearer token imdb7plus uses)
  tmdbBearer: process.env.TMDB_API_BEARER || "",
  // funny-post links for Korean users (src/humor.js)
  humorEnabled: process.env.HUMOR_ENABLED !== "0",
  humorRefreshMs: Math.max(10, int(process.env.HUMOR_REFRESH_MINUTES, 10)) * 60 * 1000, // never more often than every 10 minutes
  maxOutputTokens: int(process.env.MAX_OUTPUT_TOKENS, 700),
};
