/**
 * When the model stops because it hit max_tokens, the reply ends mid-sentence. Cut it back to
 * the last complete sentence or line so the user never sees a half-finished word.
 * Text without any sentence end is returned unchanged (nothing sensible to cut to).
 */
const SENTENCE_END = /[.!?。！？…~][)"'」』\]]?|[\u{1F300}-\u{1FAFF}]/gu;

function trimToLastSentence(text) {
  const trimmed = String(text || "").trimEnd();
  let cut = -1;
  for (const m of trimmed.matchAll(SENTENCE_END)) {
    // the "." of a list number ("3. Mushishi") is not the end of a sentence
    if (m[0][0] === "." && /(^|\n)\s*\d{1,2}$/.test(trimmed.slice(0, m.index))) continue;
    cut = m.index + m[0].length;
  }
  const newline = trimmed.lastIndexOf("\n");
  if (newline > cut) cut = newline;
  // keep at least ~30% of the reply, otherwise cutting would throw most of it away
  return cut > trimmed.length * 0.3 ? trimmed.slice(0, cut).trimEnd() : trimmed;
}

module.exports = { trimToLastSentence };
