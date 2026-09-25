// Recommendations must come from the get_titles tool (only its titles carry a TMDB id, so only they
// become links). The prompt asks for it, but the model sometimes lists films from memory instead
// (seen with "recommend a horror movie"). A draft that names titles (⟦ ⟧ markers) although no
// lookup ran this turn is redone once, with a note that sends it to the tool.
const deepseek = require("./deepseek");
const titleLinks = require("./titleLinks");

const NO_LOOKUP_NOTE =
  "You named movies, TV series or anime without using the get_titles tool. If the user asked for recommendations, what to watch, " +
  "what is popular or your favourites, call get_titles now (worldwide and the user's country unless they named a country) and " +
  "answer only with titles it returns. Otherwise answer again without naming any movie, series or anime the user did not name.";

/** deepseek.converse, plus one retry when titles were named without a lookup. */
async function converseWithLookup(messages, options = {}) {
  const context = options.context || {};
  let result = await deepseek.converse(messages, options);
  const looked = Array.isArray(context.knownTitles) && context.knownTitles.length > 0;
  if (!looked && titleLinks.namesTitles(result.text)) {
    console.log("[recommend] titles named without a lookup; redoing once with the lookup note");
    result = await deepseek.converse([...messages, { role: "system", content: NO_LOOKUP_NOTE }], options);
  }
  return result;
}

module.exports = { converseWithLookup, NO_LOOKUP_NOTE };
