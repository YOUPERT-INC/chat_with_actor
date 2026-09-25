// "품번" (product code) requests. When the user's message contains the word for product code (in any
// of the app languages), the model is not asked: the server answers with a fixed template and the
// next titles of the "User's Pick" list (swipex_nodejs: `movie` with seeding_favorite=1), most
// recommended (favorite_count) first, skipping the ones already recommended in this conversation.
// The product code is the movie's `title` field (its `code` field is a source URL). Each code
// becomes a link: {start, end, title, movie_id, type: "av"}; the app opens the page by movie_id.
const db = require("./db");

const PAGE_SIZE = 5;
const MAX_NAMES = 2; // actresses shown per title

// "product code" in each app language (ko, ja, zh, zh-tw, en, id, ms, ru, th, vi), matched whatever
// the app language is: a user may type it in another language
const KEYWORD_RE = new RegExp(
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

// a product code looks like "MVSD-696" / "FC2-PPV-1234567": no spaces, no CJK
const CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/;

const TEXT = {
  ko: {
    intro: "User's Pick 작품 중 추천 수가 많은 순서로 골라 봤어요. 품번을 누르면 상세 페이지가 열려요.",
    outro: "다른 작품도 보고 싶으면 '품번'이라고 다시 말해 주세요.",
    reset: "준비된 작품을 모두 추천해 드려서, 처음부터 다시 추천해요.",
    none: "지금은 추천할 작품을 찾지 못했어요. 잠시 후 다시 시도해 주세요.",
  },
  ja: {
    intro: "ユーザーズピックから、おすすめ数が多い順に選びました。品番をタップすると詳細ページが開きます。",
    outro: "他の作品も見たいときは、もう一度「品番」と送ってください。",
    reset: "用意した作品をすべてご紹介したので、最初からご紹介します。",
    none: "今はおすすめできる作品が見つかりませんでした。しばらくしてからもう一度お試しください。",
  },
  zh: {
    intro: "从 User's Pick 中按推荐数从高到低为你挑选了作品。点击番号即可打开详情页。",
    outro: "想看更多作品，请再次发送“番号”。",
    reset: "已推荐完全部作品，现在从头开始推荐。",
    none: "暂时没有找到可推荐的作品，请稍后再试。",
  },
  "zh-tw": {
    intro: "從 User's Pick 中依推薦數由高到低為你挑選了作品。點擊番號即可開啟詳情頁。",
    outro: "想看更多作品，請再次傳送「番號」。",
    reset: "已推薦完全部作品，現在從頭開始推薦。",
    none: "暫時沒有找到可推薦的作品，請稍後再試。",
  },
  en: {
    intro: "Here are picks from User's Pick, most recommended first. Tap a product code to open its detail page.",
    outro: 'Send "product code" again for more.',
    reset: "You have seen every pick, so I'm starting over from the top.",
    none: "I couldn't find any picks right now. Please try again later.",
  },
  id: {
    intro: "Ini pilihan dari User's Pick, diurutkan dari yang paling banyak direkomendasikan. Ketuk kode produk untuk membuka halaman detail.",
    outro: 'Kirim "kode produk" lagi untuk melihat yang lain.',
    reset: "Semua pilihan sudah ditampilkan, jadi saya mulai lagi dari awal.",
    none: "Belum ada pilihan yang bisa direkomendasikan. Coba lagi nanti.",
  },
  ms: {
    intro: "Berikut pilihan daripada User's Pick, disusun mengikut paling banyak disyorkan. Ketik kod produk untuk membuka halaman butiran.",
    outro: 'Hantar "kod produk" lagi untuk lihat yang lain.',
    reset: "Semua pilihan telah dipaparkan, jadi saya mulakan semula dari awal.",
    none: "Tiada pilihan yang boleh disyorkan buat masa ini. Sila cuba lagi nanti.",
  },
  ru: {
    intro: "Вот подборка из User's Pick, от самых рекомендуемых. Нажмите на артикул, чтобы открыть страницу с подробностями.",
    outro: "Отправьте «артикул» ещё раз, чтобы увидеть другие.",
    reset: "Все подборки показаны, начинаю сначала.",
    none: "Сейчас нет подходящих работ. Попробуйте позже.",
  },
  th: {
    intro: "นี่คือรายการจาก User's Pick เรียงตามจำนวนการแนะนำมากที่สุด แตะรหัสสินค้าเพื่อเปิดหน้ารายละเอียด",
    outro: 'ส่งคำว่า "รหัสสินค้า" อีกครั้งเพื่อดูเรื่องอื่น',
    reset: "แนะนำครบทุกเรื่องแล้ว จึงเริ่มใหม่จากต้น",
    none: "ตอนนี้ยังไม่พบเรื่องที่แนะนำได้ กรุณาลองใหม่ภายหลัง",
  },
  vi: {
    intro: "Đây là các phim chọn từ User's Pick, xếp theo số lượt đề xuất nhiều nhất. Chạm vào mã sản phẩm để mở trang chi tiết.",
    outro: 'Hãy gửi lại "mã sản phẩm" để xem thêm.',
    reset: "Đã giới thiệu hết các phim, mình bắt đầu lại từ đầu.",
    none: "Hiện chưa tìm thấy phim nào để đề xuất. Vui lòng thử lại sau.",
  },
};
TEXT.tw = TEXT["zh-tw"];

// which of an actress's names (also_known_as) to show, best first, per app language
const NAME_ORDER = { ko: ["kr", "jp", "en"], ja: ["jp"], zh: ["jp", "tw", "en"], "zh-tw": ["tw", "jp", "en"], tw: ["tw", "jp", "en"] };

const textFor = (lang) => TEXT[lang] || TEXT.en;

/** Does the message ask for product codes (contains the keyword, in any app language)? */
function wantsProductList(text) {
  return KEYWORD_RE.test(String(text || ""));
}

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
      .slice(0, MAX_NAMES)
      .map((a) => a && (byId.get(a.person_id) || a.name))
      .filter(Boolean)
      .join(", ");
}

/** The next titles of the list: most favourited first, not yet recommended here; starts over when all were. */
async function nextPicks(conv, count) {
  const seen = Array.isArray(conv.recommended_movies) ? conv.recommended_movies : [];
  const base = { seeding_favorite: 1, is_active: 1, title: { $regex: CODE_SHAPE } };
  const find = (filter) =>
    db
      .movies()
      .find(filter, { projection: { title: 1, actress: 1 } })
      .sort({ favorite_count: -1, seeding_favorite_time: -1 })
      .limit(count)
      .toArray();
  let rows = await find(seen.length ? { ...base, _id: { $nin: seen } } : base);
  let reset = false;
  if (!rows.length && seen.length) {
    reset = true;
    rows = await find(base);
  }
  return { rows, reset };
}

/**
 * @param {{recommended_movies?: any[]}} conv the conversation (its earlier recommendations)
 * @param {string} lang app language
 * @returns {Promise<{text: string, links: object[], ids: any[], reset: boolean}>} `ids` = the movies
 *   shown now (to be remembered); with `reset` they replace the remembered list
 */
async function buildReply(conv, lang) {
  const t = textFor(lang);
  const { rows, reset } = await nextPicks(conv, PAGE_SIZE);
  if (!rows.length) return { text: t.none, links: [], ids: [], reset: false };

  const namesOf = await actressNames(rows, lang);
  let text = (reset ? `${t.reset}\n` : "") + `${t.intro}\n`;
  const links = [];
  rows.forEach((m, i) => {
    text += `\n${i + 1}. `;
    const start = text.length;
    text += m.title;
    links.push({ start, end: text.length, title: m.title, movie_id: String(m._id), type: "av" });
    const names = namesOf(m);
    if (names) text += ` - ${names}`;
  });
  text += `\n\n${t.outro}`;
  return { text, links, ids: rows.map((m) => m._id), reset };
}

module.exports = { wantsProductList, buildReply, PAGE_SIZE, TEXT };
