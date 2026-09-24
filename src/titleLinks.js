// Title links: the model wraps every movie / TV / anime title it names in ⟦ ⟧. The server removes
// the brackets and returns where each title sits in the final text (`links`), so the app can show
// it as a tappable link. Nothing here is an address; the app looks the title up itself.

const OPEN = "⟦";
const CLOSE = "⟧";
const MARK_RE = /⟦([^⟦⟧\n]{1,80})⟧(?:\s?[(（](\d{4})[)）])?/g;
const MAX_LINKS = 12;

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

/**
 * @param {string} text model text containing ⟦Title⟧ markers
 * @param {Array<{title?: string, original_title?: string, year?: number, type?: string}>} known titles seen in tool results
 * @returns {{text: string, links: Array<{start: number, end: number, title: string, year: number|null, type: string|null}>}}
 */
function extractTitleLinks(text, known = []) {
  const byName = new Map();
  for (const k of known) {
    for (const name of [k.title, k.original_title]) {
      if (name) byName.set(clean(name).toLowerCase(), k);
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

    const hit = byName.get(title.toLowerCase());
    const year = m[2] ? parseInt(m[2], 10) : (hit && hit.year) || null;
    const type = hit && hit.type ? (hit.type === "animation" ? "tv" : hit.type) : null;
    if (title && links.length < MAX_LINKS) links.push({ start, end, title, year, type });
  }
  out += text.slice(cursor);
  // a bracket left over (unclosed, or cut off by the token limit) is never shown
  out = out.split(OPEN).join("").split(CLOSE).join("");
  return { text: out, links };
}

const normName = (t) => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Titles of the books listed in a verified-facts text ("1. 「최저。」 (最低。, ..."): both names. */
function bookTitles(facts) {
  const names = new Set();
  for (const m of String(facts || "").matchAll(/^\s*\d+\.\s*「([^」]+)」\s*\(([^,)"]+)/gm)) {
    names.add(normName(m[1]));
    names.add(normName(m[2]));
  }
  names.delete("");
  return names;
}

/**
 * Keeps only the links the app can really open: a title in `exclude` (books and the like) never
 * gets one, and `verify` (TMDB) must know it as a movie or series. A failed check drops the link:
 * no link is better than a wrong page. Text and offsets are untouched.
 */
async function keepOpenable(links, { exclude = new Set(), verify }) {
  const kept = [];
  await Promise.all(
    links.map(async (link, i) => {
      if (exclude.has(normName(link.title))) return;
      try {
        const hit = await verify(link);
        if (hit) kept[i] = { ...link, type: hit.type || link.type, year: link.year || hit.year || null };
      } catch (error) {
        console.log(`[title-links] check failed for "${link.title}": ${error.message}`);
      }
    })
  );
  return kept.filter(Boolean);
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

const stripMarkers = (text) => String(text).split(OPEN).join("").split(CLOSE).join("");

module.exports = { extractTitleLinks, keepOpenable, bookTitles, applyMarkers, stripMarkers, OPEN, CLOSE };
