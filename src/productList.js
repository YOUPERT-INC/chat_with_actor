// Product-code lists ("품번"). When the user's message contains a list keyword (in any of the app
// languages), the model is not asked: the server answers with a fixed template and the next titles
// of that list, most recommended (favorite_count) first, continuing after the last one already
// recommended in this conversation.
//
//   all         "품번" / product code ...      every active title that has a favorite_count
//   uncensored  노모, 無修正, Uncensored ...    category Uncensored
//   fc2         FC2                            category FC2
//   leaked      모자이크 제거, モザイク除去 ...  category Leaked
//
// The product code is the movie's `title` field (its `code` field is a source URL). Each code
// becomes a link: {start, end, title, movie_id, type: "av", year?, thumbnail?, cover?}; the app opens
// the page by movie_id (GET /swx/movie/detail/<movie_id>), no search.
const db = require("./db");

const PAGE_SIZE = 5;
const MAX_NAMES = 2; // actresses shown per title

// ---- which list the message asks for -------------------------------------------------------

// category keywords per language, matched whatever the app language is. A longer keyword wins over
// a shorter one it contains ("AI Uncensored" beats "Uncensored").
const CATEGORIES = {
  uncensored: {
    id: "5f7592975c425008d254a789",
    keywords: [
      "노모", // ko
      "無修正", "ノーモ", "解禁", // ja
      "Uncensored", "Original Uncensored", "No Mosaic", // en (also id, ms, th, vi)
      "无码", "原版无码", "无码流出", // zh
      "Tanpa Sensor", "No Sensor", // id
      "Tiada Sensor", // ms
      "無碼", "原版無碼", "無碼流出", // zh-tw
      "ไร้เซ็นเซอร์", "ไม่เซ็นเซอร์", // th
      "Không Che", "Nguyên Bản Không Che", // vi
    ],
  },
  leaked: {
    id: "638ba0b6e6248f567f04b84c",
    keywords: [
      "모파", "모자이크 파괴", "모자이크 제거", // ko
      "モザイク除去", "モザイク破壊", "AI修復", "漏れ", // ja (AI修復 is also zh-tw)
      "Mosaic Removed", "Decensored", "Uncensored Leaked", "AI Uncensored", // en
      "去码", "破码", "AI修复", "AI去码", // zh
      "Hapus Sensor", "Hilangkan Sensor", "AI No Sensor", // id (Hapus Sensor is also ms)
      "Buang Sensor", // ms
      "去碼", "破碼", "AI去碼", // zh-tw
      "ลบเซ็นเซอร์", "ถอดเซ็นเซอร์", "AI ลบเซ็นเซอร์", // th
      "Xóa Che", "Gỡ Che", "AI Xóa Che", // vi
    ],
  },
  fc2: {
    id: "606d1f633a5281073f6c18b4",
    keywords: ["FC2"], // whatever the language
  },
};

// "product code" in each app language: the plain list (no category)
const PRODUCT_CODE_RE = new RegExp(
  [
    "품번",
    "品番",
    "番号",
    "番號",
    "product\\s+(?:code|number)",
    "catalog(?:ue)?\\s+(?:code|number)",
    "item\\s+(?:code|number)",
    "kode\\s+produk",
    "nomor\\s+produk",
    "kod\\s+produk",
    "nombor\\s+produk",
    "артикул",
    "код\\s+продукта",
    "รหัสสินค้า",
    "รหัสหนัง",
    "mã\\s+sản\\s+phẩm",
    "mã\\s+số",
    "mã\\s+phim",
  ].join("|"),
  "i"
);

// NFKC: a keyboard may send Hangul as separate jamo (or full-width letters); they must still match.
// Case and spacing are ignored ("모자이크파괴" = "모자이크 파괴").
const squash = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");

const CATEGORY_KEYWORDS = Object.entries(CATEGORIES).flatMap(([key, c]) => c.keywords.map((k) => ({ key, word: squash(k) })));

/**
 * Which list does the message ask for? A category keyword wins over the plain product-code word;
 * among category keywords the longest match wins, then the one that comes first in the message.
 * @returns {"uncensored"|"leaked"|"fc2"|"all"|null}
 */
function detectList(text) {
  const t = squash(text);
  if (!t) return null;
  let best = null;
  for (const { key, word } of CATEGORY_KEYWORDS) {
    const at = t.indexOf(word);
    if (at < 0) continue;
    if (!best || word.length > best.len || (word.length === best.len && at < best.at)) best = { key, len: word.length, at };
  }
  if (best) return best.key;
  return PRODUCT_CODE_RE.test(String(text).normalize("NFKC")) ? "all" : null;
}

/** Does the message ask for a product-code list at all? */
const wantsProductList = (text) => detectList(text) !== null;

// ---- template texts ------------------------------------------------------------------------

// Friendly, casual register (the avatar talks like a close friend / partner). `intro` is for the
// plain list; `introCategory` names the category ({list}, see LABELS). `reset` is put before the
// intro when the list started over.
const TEXT = {
  ko: {
    intro: "유저들 추천 수가 많은 순서로 골라 봤어. 또 궁금한 게 있으면 물어 봐.",
    introCategory: "{list} 작품 중 유저들 추천 수가 많은 순서로 골라 봤어. 또 궁금한 게 있으면 물어 봐.",
    reset: "다 보여 줬으니까 처음부터 다시 골라 봤어.",
    none: "지금은 추천할 작품을 못 찾았어. 잠시 뒤에 다시 물어 봐.",
  },
  ja: {
    intro: "ユーザーのおすすめ数が多い順に選んでみたよ。他にも気になることがあったら聞いてね。",
    introCategory: "{list}の作品から、ユーザーのおすすめ数が多い順に選んでみたよ。他にも気になることがあったら聞いてね。",
    reset: "全部紹介したから、最初からまた選んでみたよ。",
    none: "今は紹介できる作品が見つからなかったよ。少ししてからまた聞いてね。",
  },
  zh: {
    intro: "按用户推荐数从高到低帮你挑好了。还有想知道的就问我吧。",
    introCategory: "从{list}作品里，按用户推荐数从高到低帮你挑好了。还有想知道的就问我吧。",
    reset: "都推荐完了，我从头再挑一遍。",
    none: "现在没找到能推荐的作品，过一会儿再问我吧。",
  },
  "zh-tw": {
    intro: "依用戶推薦數由高到低幫你挑好了。還有想知道的就問我吧。",
    introCategory: "從{list}作品裡，依用戶推薦數由高到低幫你挑好了。還有想知道的就問我吧。",
    reset: "都推薦完了，我從頭再挑一遍。",
    none: "現在沒找到能推薦的作品，等一下再問我吧。",
  },
  en: {
    intro: "Picked these by most user recommendations. Ask me if you're curious about anything else!",
    introCategory: "Picked these {list} titles by most user recommendations. Ask me if you're curious about anything else!",
    reset: "I've shown you all of them, so I started over from the top.",
    none: "Couldn't find anything to recommend right now. Ask me again in a bit!",
  },
  id: {
    intro: "Aku pilihin yang paling banyak direkomendasikan pengguna. Kalau ada yang mau ditanyain lagi, tanya aja ya.",
    introCategory: "Aku pilihin {list} yang paling banyak direkomendasikan pengguna. Kalau ada yang mau ditanyain lagi, tanya aja ya.",
    reset: "Semuanya udah kutunjukin, jadi aku mulai lagi dari awal.",
    none: "Lagi nggak nemu yang bisa direkomendasiin. Coba tanya lagi nanti ya.",
  },
  ms: {
    intro: "Aku pilihkan yang paling banyak disyorkan pengguna. Kalau nak tanya apa-apa lagi, tanya je.",
    introCategory: "Aku pilihkan {list} yang paling banyak disyorkan pengguna. Kalau nak tanya apa-apa lagi, tanya je.",
    reset: "Semua dah aku tunjuk, jadi aku mula semula dari awal.",
    none: "Tak jumpa yang boleh disyorkan sekarang. Tanya lagi nanti ya.",
  },
  ru: {
    intro: "Вот подборка по числу рекомендаций от пользователей. Если что-то ещё интересно — спрашивай!",
    introCategory: "Вот подборка «{list}» по числу рекомендаций от пользователей. Если что-то ещё интересно — спрашивай!",
    reset: "Всё уже показали, так что начинаем сначала.",
    none: "Пока ничего подходящего не нашлось. Спроси ещё раз чуть позже!",
  },
  th: {
    intro: "เลือกมาให้ตามจำนวนคนแนะนำเยอะสุดนะ อยากรู้อะไรอีกก็ถามได้เลย",
    introCategory: "เลือก {list} มาให้ตามจำนวนคนแนะนำเยอะสุดนะ อยากรู้อะไรอีกก็ถามได้เลย",
    reset: "แนะนำครบหมดแล้ว เลยเริ่มใหม่จากต้นนะ",
    none: "ตอนนี้ยังหาเรื่องที่แนะนำไม่เจอ ไว้ถามใหม่อีกทีนะ",
  },
  vi: {
    intro: "Mình chọn theo số lượt người dùng đề xuất nhiều nhất nè. Muốn biết gì nữa thì cứ hỏi nhé!",
    introCategory: "Mình chọn phim {list} theo số lượt người dùng đề xuất nhiều nhất nè. Muốn biết gì nữa thì cứ hỏi nhé!",
    reset: "Mình giới thiệu hết rồi, nên bắt đầu lại từ đầu nè.",
    none: "Giờ chưa tìm được phim nào để đề xuất. Lát nữa hỏi lại nhé!",
  },
};
TEXT.tw = TEXT["zh-tw"];

// the name of each category, per app language (the plain list needs none)
const LABELS = {
  ko: { uncensored: "노모(무수정)", fc2: "FC2", leaked: "모자이크 제거(유출)" },
  ja: { uncensored: "無修正", fc2: "FC2", leaked: "モザイク除去" },
  zh: { uncensored: "无码", fc2: "FC2", leaked: "去码" },
  "zh-tw": { uncensored: "無碼", fc2: "FC2", leaked: "去碼" },
  en: { uncensored: "Uncensored", fc2: "FC2", leaked: "Mosaic Removed" },
  id: { uncensored: "Tanpa Sensor", fc2: "FC2", leaked: "Hapus Sensor" },
  ms: { uncensored: "Tanpa Sensor", fc2: "FC2", leaked: "Buang Sensor" },
  ru: { uncensored: "Без цензуры", fc2: "FC2", leaked: "Цензура удалена" },
  th: { uncensored: "ไร้เซ็นเซอร์", fc2: "FC2", leaked: "ลบเซ็นเซอร์" },
  vi: { uncensored: "Không Che", fc2: "FC2", leaked: "Xóa Che" },
};
LABELS.tw = LABELS["zh-tw"];

// which of an actress's names (also_known_as) to show, best first, per app language
const NAME_ORDER = { ko: ["kr", "jp", "en"], ja: ["jp"], zh: ["jp", "tw", "en"], "zh-tw": ["tw", "jp", "en"], tw: ["tw", "jp", "en"] };

const textFor = (lang) => TEXT[lang] || TEXT.en;
const labelFor = (lang, key) => (LABELS[lang] || LABELS.en)[key];

// ---- data ----------------------------------------------------------------------------------

// a product code looks like "MVSD-696" / "FC2-PPV-1234567": no spaces, no CJK
const CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/;

// some titles carry a placeholder instead of an actress name: shown as nothing
const PLACEHOLDER_NAME = /^(unknown|n\/a|none|不明|未知|알 수 없음|-)$/i;

/** person_id -> the name to show in this language (falls back to the name stored on the movie). */
async function actressNames(movies, lang) {
  const ids = [...new Set(movies.flatMap((m) => (Array.isArray(m.actress) ? m.actress : []).map((a) => a && a.person_id).filter(Boolean)))];
  const byId = new Map();
  if (ids.length) {
    const docs = await db.actresses().find({ person_id: { $in: ids } }, { projection: { person_id: 1, name: 1, also_known_as: 1 } }).toArray();
    const order = NAME_ORDER[lang] || ["en", "jp"];
    for (const d of docs) {
      const aka = d.also_known_as || {};
      const name = order.map((k) => aka[k]).find(Boolean) || aka.jp || d.name;
      if (name) byId.set(d.person_id, String(name));
    }
  }
  return (movie) =>
    (Array.isArray(movie.actress) ? movie.actress : [])
      .map((a) => a && (byId.get(a.person_id) || a.name))
      .filter((name) => name && !PLACEHOLDER_NAME.test(String(name).trim()))
      .slice(0, MAX_NAMES)
      .join(", ");
}

// The plain list = every title with a favourite_count (~225k), most favourited first. The sort needs
// the index `chat_product_rank` ({is_active: 1, favorite_count: -1, _id: -1}, partial favorite_count > 0
// on `movie`): without it the sort scans the whole collection (~4 s), so then the small "User's Pick"
// set (seeding_favorite = 1, ~850 titles, has its own index) is used instead.
// A category list is ~10k-40k titles: it uses `chat_category_rank` ({category_id: 1, is_active: 1,
// favorite_count: -1, _id: -1}, partial favorite_count exists) when it exists, and is only slower without.
const RANK_INDEX = "chat_product_rank";
const CATEGORY_INDEX = "chat_category_rank";
const INDEX_CHECK_MS = 5 * 60 * 1000;
const indexState = new Map(); // index name -> { ok, at }

async function hasIndex(name) {
  const known = indexState.get(name);
  if (known && Date.now() - known.at < INDEX_CHECK_MS) return known.ok;
  let ok = false;
  try {
    ok = await db.movies().indexExists(name);
  } catch (error) {
    console.log(`[productList] index check failed (${name}):`, error.message);
  }
  if (!known || known.ok !== ok) console.log(`[productList] index ${name}: ${ok ? "found" : "MISSING"}`);
  indexState.set(name, { ok, at: Date.now() });
  return ok;
}

// what is stored on the conversation, per list (`product_cursors.<list>`): the last title shown, {fav, id}
const cursorOf = (row) => ({ fav: row.favorite_count || 0, id: row._id });
const validCursor = (c) => c && typeof c === "object" && typeof c.fav === "number" && c.id;

async function baseFilter(list) {
  const category = CATEGORIES[list];
  if (category) return { favorite_count: { $exists: true }, category_id: category.id, is_active: 1, title: { $regex: CODE_SHAPE } };
  if (await hasIndex(RANK_INDEX)) return { is_active: 1, favorite_count: { $gt: 0 }, title: { $regex: CODE_SHAPE } };
  return { seeding_favorite: 1, is_active: 1, title: { $regex: CODE_SHAPE } };
}

/** The next titles of the list, most favourited first, continuing after the cursor; starts over when the list ends. */
async function nextPicks(conv, list, count) {
  const base = await baseFilter(list);
  if (CATEGORIES[list]) await hasIndex(CATEGORY_INDEX); // only so that a missing index is logged once
  const find = (filter) =>
    db
      .movies()
      .find(filter, { projection: { title: 1, actress: 1, share_date: 1, thumbnail: 1, cover_url: 1, favorite_count: 1 } })
      .sort({ favorite_count: -1, _id: -1 })
      .limit(count)
      .toArray();
  const stored = conv && conv.product_cursors && conv.product_cursors[list];
  const c = validCursor(stored) ? stored : null;
  const after = c ? { $or: [{ favorite_count: { $lt: c.fav } }, { favorite_count: c.fav, _id: { $lt: c.id } }] } : {};
  let rows = await find({ ...base, ...after });
  let reset = false;
  if (!rows.length && c) {
    reset = true;
    rows = await find(base);
  }
  return { rows, reset, continued: Boolean(c) };
}

/**
 * @param {{product_cursors?: object}} conv the conversation (where each of its lists stopped)
 * @param {string} lang app language
 * @param {"all"|"uncensored"|"fc2"|"leaked"} list which list (see detectList)
 * @returns {Promise<{text: string, links: object[], cursor: object|null, reset: boolean}>} `cursor` = the
 *   last title shown now (to be stored as `product_cursors.<list>` for the next request)
 */
async function buildReply(conv, lang, list = "all") {
  const t = textFor(lang);
  const started = Date.now();
  const { rows, reset, continued } = await nextPicks(conv, list, PAGE_SIZE);
  console.log(`[productList] list=${list} lang=${lang} shown=${rows.length} reset=${reset} continued=${continued} ${Date.now() - started}ms`);
  if (!rows.length) return { text: t.none, links: [], cursor: null, reset: false };

  const namesOf = await actressNames(rows, lang);
  const intro = list === "all" ? t.intro : t.introCategory.replace("{list}", labelFor(lang, list));
  let text = (reset ? `${t.reset}\n` : "") + intro;
  const links = [];
  rows.forEach((m) => {
    text += "\n";
    const start = text.length;
    text += m.title;
    const end = text.length;
    const year = parseInt(String(m.share_date || "").slice(0, 4), 10);
    if (year > 1900) text += ` (${year})`;
    links.push({
      start,
      end,
      title: m.title,
      movie_id: String(m._id),
      type: "av",
      ...(year > 1900 ? { year } : {}),
      // raw images (poster and wide cover can differ): the app shows what the X list shows
      ...(typeof m.thumbnail === "string" && m.thumbnail ? { thumbnail: m.thumbnail } : {}),
      ...(typeof m.cover_url === "string" && m.cover_url ? { cover: m.cover_url } : {}),
    });
    const names = namesOf(m);
    if (names) text += ` - ${names}`;
  });
  return { text, links, cursor: cursorOf(rows[rows.length - 1]), reset };
}

const _resetIndexCheck = () => indexState.clear();

module.exports = { detectList, wantsProductList, buildReply, PAGE_SIZE, TEXT, LABELS, CATEGORIES, RANK_INDEX, CATEGORY_INDEX, _resetIndexCheck };
