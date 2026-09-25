// Title links: the model wraps every movie / TV / anime title it names in ⟦ ⟧. The server removes
// the brackets and returns where each title sits in the final text (`links`), so the app can show
// it as a tappable link. Nothing here is an address; only titles the tools returned (with their TMDB
// id) become links, and the app opens the title's page by that id.

const OPEN = "⟦";
const CLOSE = "⟧";
const MARK_RE = /⟦([^⟦⟧\n]{1,80})⟧(?:\s?[(（](\d{4})[)）])?/g;
const MAX_LINKS = 12;

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
// case, spacing and punctuation ignored: "Spider-Man: Homecoming" and "spiderman homecoming" are one name
const normName = (t) => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * @param {string} text model text containing ⟦Title⟧ markers
 * @param {Array<{title?: string, original_title?: string, year?: number, type?: string}>} known titles seen in tool results
 * @returns {{text: string, links: Array<{start: number, end: number, title: string, year: number|null, type: string|null}>}}
 */
function extractTitleLinks(text, known = []) {
  const byName = new Map();
  for (const k of known) {
    for (const name of [k.title, k.original_title]) {
      if (name) byName.set(normName(name), k);
    }
  }

  let out = "";
  let cursor = 0;
  const links = [];
  for (const m of String(text).matchAll(MARK_RE)) {
    out += text.slice(cursor, m.index);
    const title = clean(m[1]);
    const start = out.length;
    out += title;
    const end = out.length;
    // keep the "(2026)" the model wrote right after the title: it is part of what she says
    const yearText = m[2] ? ` (${m[2]})` : "";
    out += yearText;
    cursor = m.index + m[0].length;

    const hit = byName.get(normName(title));
    const year = m[2] ? parseInt(m[2], 10) : (hit && hit.year) || null;
    // anything but "movie" / "tv" says nothing about film vs series: leave the type open
    const rawType = hit && (hit.tmdb_type || hit.type);
    const type = rawType === "movie" || rawType === "tv" ? rawType : null;
    const link = { start, end, title, year, type };
    // ids of the source the title came from: the app opens the page by id, no name search
    if (hit && hit.tmdb_id) link.tmdb_id = hit.tmdb_id;
    if (hit && hit.imdb_id) link.imdb_id = hit.imdb_id;
    if (title && links.length < MAX_LINKS) links.push(link);
  }
  out += text.slice(cursor);
  // a bracket left over (unclosed, or cut off by the token limit) is never shown
  out = out.split(OPEN).join("").split(CLOSE).join("");
  return { text: out, links };
}

/**
 * Keeps only the links the app can really open: a title the tools returned this turn, which comes
 * with the id of its TMDB page. A title the model wrote from memory has no id and gets no link (no
 * title search: no link is better than a wrong page). Text and offsets are untouched.
 */
function keepOpenable(links) {
  return links.filter((link) => link.tmdb_id || link.imdb_id);
}

/** Put the markers back into a stored reply so the model keeps seeing (and using) the format. */
function applyMarkers(content, links) {
  if (!Array.isArray(links) || !links.length) return content;
  let out = "";
  let cursor = 0;
  for (const l of [...links].sort((a, b) => a.start - b.start)) {
    if (l.start < cursor || l.end > content.length) continue;
    out += content.slice(cursor, l.start) + OPEN + content.slice(l.start, l.end) + CLOSE;
    cursor = l.end;
  }
  return out + content.slice(cursor);
}

// Sent right after the chat history. In a chat whose earlier replies have no markers the model
// copies that habit and the app gets no links (seen in production), so it is repeated here.
const MARK_REMINDER =
  "Format reminder: wrap the name of every movie, TV series or anime you mention in ⟦ ⟧ followed by its year in normal brackets, as in ⟦Parasite⟧ (2019), even if your earlier replies in this chat did not. Never for books, games, music or people.";

/** Does the text name titles (⟦ ⟧ markers)? */
const namesTitles = (text) => new RegExp(MARK_RE.source).test(String(text || ""));

const stripMarkers =(text) => String(text).split(OPEN).join("").split(CLOSE).join("");

module.exports = { extractTitleLinks, keepOpenable, applyMarkers, stripMarkers, namesTitles, MARK_REMINDER, OPEN, CLOSE };
