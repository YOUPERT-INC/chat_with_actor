/**
 * "Something funny" links for Korean users.
 *
 * The avatar can hand the user ONE link to a currently popular post of a Korean community.
 * Nothing but the title and the address is ever taken from those sites (no post body, no
 * images). Sources (chosen by the operator, 2026-09):
 *   - dcbest  : DCInside "실시간 베스트" list page (newest first). Used first.
 *   - ppomppu : Ppomppu "유머/감동" RSS feed (most viewed of the last 24h).
 * Not used: humoruniv and fmkorea, which block automated access (a JS redirect page and an anti-bot
 * wall respectively); we do not work around access controls.
 *
 * Rules of the road: the requests say who we are (Flix1LinkBot + contact), stay well under one
 * request per source per 10 minutes, and back off (never retry with another identity) when a
 * site answers with anything but 200. Content is deliberately NOT filtered by topic (operator
 * decision: the sources are lawful all-ages sites); what IS enforced is technical: only https
 * links on the two allowed hosts are ever handed out, and the LINK IS APPENDED BY THE SERVER, so
 * the model can neither garble the address nor lose it when it declines to comment on a title.
 */
const axios = require("axios");
const config = require("./config");

const USER_AGENT = "Flix1LinkBot/1.0 (+https://flix1.net; contact: support@flix1.net)";
const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_TITLE_CHARS = 120;
const BACKOFF_BASE_MS = 10 * 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
const PPOMPPU_WINDOW_MS = 24 * 60 * 60 * 1000;
const DC_CANDIDATES = 300;
const ALLOWED_HOSTS = new Set(["gall.dcinside.com", "www.ppomppu.co.kr"]);

// ---------------------------------------------------------------------------------------------
// parsing

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(text) {
  return String(text)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : m));
}

function cleanTitle(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, " "))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_CHARS);
}

/** DCInside 실시간 베스트 list page -> posts (survey and notice rows skipped). */
function parseDcBest(html) {
  const posts = [];
  const rowRe = /<tr class="ub-content[^"]*"([^>]*)>([\s\S]*?)<\/tr>/g;
  for (const m of String(html).matchAll(rowRe)) {
    const attrs = m[1];
    const body = m[2];
    const no = /data-no="(\d+)"/.exec(attrs);
    if (!no || /data-type="icon_notice"/.test(attrs)) continue;
    const num = /<td class="gall_num">\s*([^<]*?)\s*<\/td>/.exec(body);
    if (!num || !/^\d+$/.test(num[1])) continue; // 공지 / 설문 / ad rows
    const anchor = /<td class="gall_tit[^"]*"[^>]*>\s*<a [^>]*>([\s\S]*?)<\/a>/.exec(body);
    const title = anchor ? cleanTitle(anchor[1]) : "";
    if (!title) continue;
    const count = /<td class="gall_count">\s*(\d+)/.exec(body);
    const rec = /<td class="gall_recommend">\s*(\d+)/.exec(body);
    posts.push({
      post_id: no[1],
      post_num: Number(no[1]),
      title,
      url: `https://gall.dcinside.com/board/view/?id=dcbest&no=${no[1]}`,
      views: count ? Number(count[1]) : 0,
      recs: rec ? Number(rec[1]) : 0,
    });
  }
  return posts;
}

/** Ppomppu 유머/감동 RSS -> posts. `<hits> [comments|views|recommend|x]`: the 2nd number is the views. */
function parsePpomppuRss(xml) {
  const posts = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1];
    const pick = (tag) => {
      const t = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`).exec(item);
      return t ? t[1] : "";
    };
    const link = decodeEntities(pick("link")).trim();
    const no = /[?&]no=(\d+)/.exec(link);
    const title = cleanTitle(decodeEntities(pick("title")));
    if (!no || !title) continue;
    const hits = /\[([^\]]*)\]/.exec(pick("hits"));
    const parts = hits ? hits[1].split("|").map((x) => parseInt(x, 10) || 0) : [];
    posts.push({
      post_id: no[1],
      post_num: Number(no[1]),
      title,
      url: link.replace(/^http:\/\//i, "https://"),
      views: parts[1] || 0,
      recs: parts[2] || 0,
    });
  }
  return posts;
}

/** Only https links on the allowed hosts may ever be shown to a user. */
function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOSTS.has(u.hostname);
  } catch (error) {
    return false;
  }
}

const SOURCES = [
  { id: "dcbest", label: "디시인사이드 실시간 베스트", url: "https://gall.dcinside.com/board/lists/?id=dcbest", parse: parseDcBest },
  { id: "ppomppu", label: "뽐뿌 유머/감동", url: "https://www.ppomppu.co.kr/rss.php?id=humor", parse: parsePpomppuRss },
];
const LABELS = Object.fromEntries(SOURCES.map((s) => [s.id, s.label]));

// ---------------------------------------------------------------------------------------------
// storage (Mongo collection humor_posts; injectable for tests)

const mongoStore = {
  async upsert(source, posts, now = new Date()) {
    const db = require("./db");
    if (!posts.length) return 0;
    const ops = posts.map((p) => ({
      updateOne: {
        filter: { source, post_id: p.post_id },
        update: {
          $setOnInsert: { source, post_id: p.post_id, post_num: p.post_num, title: p.title, url: p.url, first_seen: now },
          $set: { views: p.views, recs: p.recs, last_seen: now },
        },
        upsert: true,
      },
    }));
    const r = await db.humorPosts().bulkWrite(ops, { ordered: false });
    return r.upsertedCount || 0;
  },
  async candidates(source, { sinceMs = 0, sort, limit }) {
    const db = require("./db");
    const filter = { source };
    if (sinceMs) filter.first_seen = { $gte: new Date(Date.now() - sinceMs) };
    return db.humorPosts().find(filter).sort(sort).limit(limit).toArray();
  },
};

// ---------------------------------------------------------------------------------------------
// refresh (fetch the list pages on a slow, polite schedule)

const health = new Map(); // source id -> { failures, nextTryAt }

async function fetchText(url, http = axios) {
  const resp = await http.get(url, {
    timeout: FETCH_TIMEOUT_MS,
    maxContentLength: MAX_BYTES,
    responseType: "text",
    transformResponse: (x) => x,
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xml;q=0.9,*/*;q=0.5" },
    validateStatus: () => true,
  });
  if (resp.status !== 200) {
    const error = new Error(`HTTP ${resp.status}`);
    error.status = resp.status;
    throw error;
  }
  return String(resp.data);
}

/** Refresh one source; on any non-200 it backs off (10, 20, 40, 60 min) and never tries to get around it. */
async function refreshSource(source, { store = mongoStore, http = axios, now = () => Date.now() } = {}) {
  const state = health.get(source.id) || { failures: 0, nextTryAt: 0 };
  if (state.nextTryAt > now()) return { source: source.id, skipped: "backoff" };
  try {
    const body = await fetchText(source.url, http);
    const posts = source.parse(body).filter((p) => isAllowedUrl(p.url));
    if (!posts.length) throw new Error("no posts parsed (page layout changed?)");
    const added = await store.upsert(source.id, posts, new Date(now()));
    health.set(source.id, { failures: 0, nextTryAt: 0 });
    return { source: source.id, parsed: posts.length, added };
  } catch (error) {
    const failures = state.failures + 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
    health.set(source.id, { failures, nextTryAt: now() + delay });
    console.log(`[humor] ${source.id} failed (${error.message}); next try in ${Math.round(delay / 60000)} min`);
    return { source: source.id, error: error.message };
  }
}

let running = false;
async function refreshAll(options) {
  if (running) return [];
  running = true;
  try {
    const results = [];
    for (const s of SOURCES) results.push(await refreshSource(s, options)); // one after another
    const summary = results.map((r) => (r.error ? `${r.source}:ERR` : r.skipped ? `${r.source}:wait` : `${r.source}:+${r.added}/${r.parsed}`)).join(" ");
    console.log(`[humor] refresh ${summary}`);
    return results;
  } finally {
    running = false;
  }
}

function startRefresh() {
  if (!config.humorEnabled) {
    console.log("[humor] disabled (HUMOR_ENABLED=0)");
    return null;
  }
  refreshAll().catch((e) => console.log("[humor] refresh crashed:", e.message));
  const timer = setInterval(() => refreshAll().catch((e) => console.log("[humor] refresh crashed:", e.message)), config.humorRefreshMs);
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------------------------------------
// choosing a post for one conversation

/**
 * DCInside first (newest first, the best list is already curated), then Ppomppu (most viewed
 * of the last 24h). Never a link this conversation has been sent before (`exclude`).
 * @returns {Promise<{source, label, title, url}|null>}
 */
async function pickPost({ exclude = new Set(), store = mongoStore } = {}) {
  const usable = (p) => p && !exclude.has(p.url) && isAllowedUrl(p.url);
  const dc = await store.candidates("dcbest", { sort: { post_num: -1 }, limit: DC_CANDIDATES });
  const fromDc = dc.find(usable);
  if (fromDc) return { source: "dcbest", label: LABELS.dcbest, title: fromDc.title, url: fromDc.url };

  const pp = await store.candidates("ppomppu", { sinceMs: PPOMPPU_WINDOW_MS, sort: { views: -1, post_num: -1 }, limit: 100 });
  const fromPp = pp.find(usable);
  return fromPp ? { source: "ppomppu", label: LABELS.ppomppu, title: fromPp.title, url: fromPp.url } : null;
}

// ---------------------------------------------------------------------------------------------
// the chat side

/** Korean-language users only (the posts are Korean). */
const isEligible = (lang) => String(lang || "").toLowerCase() === "ko";

const FUNNY_HINT =
  "If the user says they are bored, asks for something funny or entertaining, asks what is trending in Korean online communities, or asks for another one, call the get_funny_post tool (each call gives a NEW post; one post per message). Never call it unprompted, and never say you found, fetched, brought or saw a post unless the app gave you one in this very message. You have only seen the post's title: say one short natural line using only the title, and never claim you read the post or describe its content, comments or reactions. Never write a URL or a link line: the app adds the link by itself.";

/** Tool result for the model: title and source only. The address is kept for the server. */
async function pickForContext(context, options = {}) {
  if (!isEligible(context.lang)) return { error: "unavailable" };
  if (context.picked && context.picked.length) {
    return { error: "already_shared", note: "One link per message: you already have one for this message." };
  }
  const post = await pickPost({ exclude: context.sharedUrls || new Set(), ...options });
  if (!post) return { error: "none", note: "Nothing new to share right now; suggest something else." };
  context.picked.push(post);
  context.sharedUrls.add(post.url);
  return {
    source: post.label,
    title: post.title,
    note: "The app adds the link by itself: do not write any URL or link line. You have only seen this title: introduce it in one short, natural line, and do not claim to have read the post or describe its content, comments or reactions.",
  };
}

/** The block the server appends to the avatar's reply (the address on its own line so the app can make it tappable). */
function linkBlock(post) {
  return `\n\n🔗 ${post.title} (${post.label})\n${post.url}`;
}

// ---------------------------------------------------------------------------------------------
// Deciding to share is done by the server for clear requests, not left to the model: left alone
// it answers "another one?" with a post it just made up (no tool call, no link). For those
// messages the server picks the post itself and tells the model what to say; when there is
// nothing new it tells the model so. (The tool stays available for phrasings not covered here.)

const ASKS_FUNNY = /(웃긴|웃기는|웃음\s*나는|재밌는|재미있는)\s*(거|것|글|게시글|게시물|짤|영상|자료|사이트|커뮤|게|거리|얘기\s*좀\s*(찾|알려|보여))|커뮤(니티)?|심심/;
const ASKS_TO_TELL = /(얘기|이야기|농담|개그|드립|유머)\s*(를|을)?\s*(해|하나|좀)/; // "tell me a joke" is not a request for a link
const ASKS_ANOTHER = /(또|다른|더|다음|하나\s*만\s*더|한\s*개\s*더|한\s*번\s*더)/;

/**
 * @param {string} text  the user's message
 * @param {{afterLink?: boolean}} context  the previous assistant message contained a link
 */
function wantsFunnyPost(text, { afterLink = false } = {}) {
  const t = String(text || "");
  if (ASKS_TO_TELL.test(t)) return false;
  if (ASKS_FUNNY.test(t)) return true;
  return afterLink && ASKS_ANOTHER.test(t) && t.length <= 40;
}

/** System note for this turn's model call, from the server's own pick (null pick = nothing new). */
function funnyNote(post) {
  if (!post) {
    return "The user wants a funny post, but there is no new one to share right now. Say so briefly in your own voice and offer something else. Do not make up any post, title or link.";
  }
  return `The user wants something funny. Share this post in your reply: "${post.title}" (${post.label}). The app adds the link by itself: do not write any URL or link line. You have only seen the title: introduce it in one short, natural line and do not claim to have read the post or describe its content, comments or reactions.`;
}

// Words of a draft that claims to be sharing a post ("찾아왔어", "라는 제목인데", "글을 가져왔어" ...).
const CLAIMS_POST = /(글|게시글|게시물|제목|짤)[^\n]{0,20}(찾아|찾았|가져|올라|봤|들고)|(찾아|찾았|가져|들고)[^\n]{0,14}(글|게시글|게시물|제목|짤)|(올라온|올라왔)\s*(글|게시글|게시물)|라는\s*(글|제목|게시)|제목인데|제목이\s*이래|제목이래/;
const claimsPost = (text) => CLAIMS_POST.test(String(text || ""));

const NO_CLAIM_NOTE =
  "Your draft said you found, fetched or saw a post, but the app has no post for this message. Write your reply again in your own voice WITHOUT claiming to have found, fetched or seen any post, title or link (you may say you have nothing new to share, or just keep chatting).";

module.exports = {
  claimsPost,
  NO_CLAIM_NOTE,
  wantsFunnyPost,
  funnyNote,
  parseDcBest,
  parsePpomppuRss,
  isAllowedUrl,
  refreshSource,
  refreshAll,
  startRefresh,
  pickPost,
  pickForContext,
  linkBlock,
  isEligible,
  FUNNY_HINT,
  SOURCES,
  USER_AGENT,
  _resetHealth: () => health.clear(),
};
