/**
 * The model must never be the source of a link.
 *
 * Real links (funny posts, see humor.js) are appended to a reply by the server as a block:
 *
 *     \n\n🔗 <title> (<source>)\n<https address>
 *
 * Models copy the shape of earlier blocks in the history and invent titles and addresses (seen in
 * testing), so: (1) the model never sees those blocks again (stripLinkBlock on history) and
 * (2) anything link-like it writes is removed before the server appends the one real block
 * (stripModelLinks).
 */

const LINK_BLOCK_RE = /\n\n🔗 [^\n]*\nhttps:\/\/\S+\s*$/u;

/** A stored assistant message without the link block the server appended. */
function stripLinkBlock(text) {
  return String(text || "").replace(LINK_BLOCK_RE, "").trimEnd();
}

/** What the model wrote, minus "🔗" lines, markdown links (their text is kept) and bare URLs. */
function stripModelLinks(text) {
  return String(text || "")
    .split("\n")
    .filter((line) => !/^\s*🔗/u.test(line))
    .join("\n")
    .replace(/\[([^\]]*)\]\((?:https?:)?\/\/[^)\s]*\)/gi, "$1")
    .replace(/[ 	]*(?:https?:\/\/|www\.)[^\s<>()]+/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = { stripLinkBlock, stripModelLinks, LINK_BLOCK_RE };
