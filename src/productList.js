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

// {list} = the name of the list in that language (LABELS)
const TEXT = {
  ko: {
    intro: "{list} 작품 중 추천 수가 많은 순서로 골라 봤어요. 품번을 누르면 상세 페이지가 열려요.",
    outro: "다른 작품도 보고 싶으면 같은 요청을 다시 보내 주세요.",
    reset: "준비된 작품을 모두 추천해 드려서, 처음부터 다시 추천해요.",
    none: "지금은 추천할 작품을 찾지 못했어요. 잠시 후 다시 시도해 주세요.",
  },
  ja: {
    intro: "{list}の作品から、おすすめ数が多い順に選びました。品番をタップすると詳細ページが開きます。",
    outro: "他の作品も見たいときは、同じ内容をもう一度送ってください。",
    reset: "用意した作品をすべてご紹介したので、最初からご紹介します。",
    none: "今はおすすめできる作品が見つかりませんでした。しばらくしてからもう一度お試しください。",
  },
  zh: {
    intro: "按推荐数从高到低，为你挑选了 {list} 作品。点击番号即可打开详情页。",
    outro: "想看更多作品，请再发送一次同样的请求。",
    reset: "已推荐完全部作品，现在从头开始推荐。",
    none: "暂时没有找到可推荐的作品，请稍后再试。",
  },
  "zh-tw": {
    intro: "依推薦數由高到低，為你挑選了 {list} 作品。點擊番號即可開啟詳情頁。",
    outro: "想看更多作品，請再傳送一次同樣的請求。",
    reset: "已推薦完全部作品，現在從頭開始推薦。",
    none: "暫時沒有找到可推薦的作品，請稍後再試。",
  },
  en: {
    intro: "Here are {list} picks, most recommended first. Tap a product code to open its detail page.",
    outro: "Send the same request again for more.",
    reset: "You have seen every pick, so I'm starting over from the top.",
    none: "I couldn't find any picks right now. Please try again later.",
  },
  id: {
    intro: "Ini pilihan {list}, diurutkan dari yang paling banyak direkomendasikan. Ketuk kode produk untuk membuka halaman detail.",
    outro: "Kirim permintaan yang sama lagi untuk melihat yang lain.",
    reset: "Semua pilihan sudah ditampilkan, jadi saya mulai lagi dari awal.",
    none: "Belum ada pilihan yang bisa direkomendasikan. Coba lagi nanti.",
  },
  ms: {
    intro: "Berikut pilihan {list}, disusun mengikut paling banyak disyorkan. Ketik kod produk untuk membuka halaman butiran.",
    outro: "Hantar permintaan yang sama lagi untuk lihat yang lain.",
    reset: "Semua pilihan telah dipaparkan, jadi saya mulakan semula dari awal.",
    none: "Tiada pilihan yang boleh disyorkan buat masa ini. Sila cuba lagi nanti.",
  },
  ru: {
    intro: "Вот подборка «{list}», от самых рекомендуемых. Нажмите на артикул, чтобы открыть страницу с подробностями.",
    outro: "Отправьте тот же запрос ещё раз, чтобы увидеть другие.",
    reset: "Все подборки показаны, начинаю сначала.",
    none: "Сейчас нет подходящих работ. Попробуйте позже.",
  },
  th: {
    intro: "นี่คือรายการ {list} เรียงตามจำนวนการแนะนำมากที่สุด แตะรหัสสินค้าเพื่อเปิดหน้ารายละเอียด",
    outro: "ส่งคำขอเดิมอีกครั้งเพื่อดูเรื่องอื่น",
    reset: "แนะนำครบทุกเรื่องแล้ว จึงเริ่มใหม่จากต้น",
    none: "ตอนนี้ยังไม่พบเรื่องที่แนะนำได้ กรุณาลองใหม่ภายหลัง",
  },
  vi: {
    intro: "Đây là các phim {list}, xếp theo số lượt đề xuất nhiều nhất. Chạm vào mã sản phẩm để mở trang chi tiết.",
    outro: "Hãy gửi lại yêu cầu tương tự để xem thêm.",
    reset: "Đã giới thiệu hết các phim, mình bắt đầu lại từ đầu.",
    none: "Hiện chưa tìm thấy phim nào để đề xuất. Vui lòng thử lại sau.",
  },
};
TEXT.tw = TEXT["zh-tw"];

// the name of each list, per app language
const LABELS = {
  ko: { all: "User's Pick", uncensored: "노모(무수정)", fc2: "FC2", leaked: "모자이크 제거(유출)" },
  ja: { all: "ユーザーズピック", uncensored: "無修正", fc2: "FC2", leaked: "モザイク除去" },
  zh: { all: "User's Pick", uncensored: "无码", fc2: "FC2", leaked: "去码" },
  "zh-tw": { all: "User's Pick", uncensored: "無碼", fc2: "FC2", leaked: "去碼" },
  en: { all: "User's Pick", uncensored: "Uncensored", fc2: "FC2", leaked: "Mosaic Removed" },
  id: { all: "User's Pick", uncensored: "Tanpa Sensor", fc2: "FC2", leaked: "Hapus Sensor" },
  ms: { all: "User's Pick", uncensored: "Tanpa Sensor", fc2: "FC2", leaked: "Buang Sensor" },
  ru: { all: "User's Pick", uncensored: "Без цензуры", fc2: "FC2", leaked: "Цензура удалена" },
  th: { all: "User's Pick", uncensored: "ไร้เซ็นเซอร์", fc2: "FC2", leaked: "ลบเซ็นเซอร์" },
  vi: { all: "User's Pick", uncensored: "Không Che", fc2: "FC2", leaked: "Xóa Che" },
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
  let text = (reset ? `${t.reset}\n` : "") + `${t.intro.replace("{list}", labelFor(lang, list))}\n`;
  const links = [];
  rows.forEach((m, i) => {
    text += `\n${i + 1}. `;
    const start = text.length;
    text += m.title;
    const year = parseInt(String(m.share_date || "").slice(0, 4), 10);
    links.push({
      start,
      end: text.length,
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
  text += `\n\n${t.outro}`;
  return { text, links, cursor: cursorOf(rows[rows.length - 1]), reset };
}

const _resetIndexCheck = () => indexState.clear();

module.exports = { detectList, wantsProductList, buildReply, PAGE_SIZE, TEXT, LABELS, CATEGORIES, RANK_INDEX, CATEGORY_INDEX, _resetIndexCheck };
