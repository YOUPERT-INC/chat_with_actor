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
  // Paid, time-limited membership (12/6/3/1-month plans): a daily AND a calendar-month cap.
  // Product-code ("품번") requests cost no DeepSeek tokens (src/productList.js answers them without
  // calling the model) and are never counted against either of these — see src/rateLimit.js instead.
  dailyMessageLimit: int(process.env.DAILY_MESSAGE_LIMIT, 15),
  monthlyMessageLimit: int(process.env.MONTHLY_MESSAGE_LIMIT, 300),
  // "Lifetime" membership: a one-time purchase, so a daily/monthly cap that resets forever would be
  // an unbounded liability against a payment collected once. Instead: a single lifetime total.
  // Detected as membership balance >= this many years left (see src/auth.js isLifetime) — the
  // lifetime plan grants 100 years at purchase, so this only mis-tags a very long ordinary plan.
  lifetimeThresholdYears: int(process.env.LIFETIME_THRESHOLD_YEARS, 10),
  lifetimeMessageLimit: int(process.env.LIFETIME_MESSAGE_LIMIT, 3600),
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
