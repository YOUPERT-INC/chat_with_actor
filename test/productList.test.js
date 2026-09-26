const test = require("node:test");
const assert = require("node:assert");
const db = require("../src/db");
const productList = require("../src/productList");

const realMovies = db.movies;
const realActresses = db.actresses;
test.afterEach(() => {
  db.movies = realMovies;
  db.actresses = realActresses;
  productList._resetIndexCheck();
});

// A fake `movie` collection. It sorts by (favorite_count desc, _id desc) like the real query and
// honours the "after the cursor" part ($or); `indexes` lists the index names that exist.
function fakeCollections(list, { actresses = [], indexes = [productList.RANK_INDEX, productList.CATEGORY_INDEX] } = {}) {
  const queries = [];
  db.movies = () => ({
    indexExists: async (name) => indexes.includes(name),
    find: (filter, opts) => {
      queries.push({ filter, opts });
      let rows = [...list].sort((a, b) => b.favorite_count - a.favorite_count || (a._id < b._id ? 1 : -1));
      if (filter.category_id) rows = rows.filter((m) => m.category_id === filter.category_id);
      if (filter.$or) {
        const [lower, tie] = filter.$or;
        rows = rows.filter((m) => m.favorite_count < lower.favorite_count.$lt || (m.favorite_count === tie.favorite_count && m._id < tie._id.$lt));
      }
      const cursor = {
        sort: (s) => {
          queries[queries.length - 1].sort = s;
          return cursor;
        },
        limit: (n) => {
          rows = rows.slice(0, n);
          return cursor;
        },
        toArray: async () => rows,
      };
      return cursor;
    },
  });
  db.actresses = () => ({ find: () => ({ toArray: async () => actresses }) });
  return queries;
}
// ids are zero-padded so that "bigger id" is also bigger as a string
const movies = (n, fav = (i) => 1000 - i, category_id = "cat") =>
  Array.from({ length: n }, (_, i) => ({
    _id: `id${String(i).padStart(3, "0")}`,
    title: `ABC-${100 + i}`,
    favorite_count: fav(i),
    category_id,
    share_date: "2024-05-0" + (i % 9 + 1),
    thumbnail: `https://img.test/thumbs/${i}.jpg`,
    cover_url: `https://img.test/covers/${i}.jpg`,
    actress: [{ person_id: "p1", name: "日本名" }],
  }));

const detect = productList.detectList;

test("product-code word in every app language, anywhere in the message: the plain list", () => {
  for (const text of ["품번 알려줘", "추천 품번 좀", "品番を教えて", "给我番号", "給我番號", "give me a product code", "catalog number please", "kode produk dong", "nomor produk", "kod produk", "nombor produk", "дай артикул", "код продукта", "ขอรหัสสินค้า", "cho mình mã sản phẩm"]) {
    assert.strictEqual(detect(text), "all", text);
  }
  // Hangul sent as separate jamo by some keyboards
  assert.strictEqual(detect("인기 있는 품번 추천해 줘.".normalize("NFD")), "all");
  for (const text of ["영화 추천해 줘", "안녕", "what is your code of conduct", "", undefined]) {
    assert.strictEqual(detect(text), null, String(text));
    assert.ok(!productList.wantsProductList(text));
  }
});

test("category keywords of the issue, per language", () => {
  const cases = {
    uncensored: ["노모 추천", "無修正 おすすめ", "ノーモ", "解禁", "Uncensored please", "original uncensored", "No Mosaic", "无码", "原版无码", "无码流出", "Tanpa Sensor", "No Sensor", "Tiada Sensor", "無碼", "原版無碼", "無碼流出", "ไร้เซ็นเซอร์", "ไม่เซ็นเซอร์", "Không Che", "Nguyên Bản Không Che"],
    leaked: ["모파 추천", "모자이크 파괴", "모자이크 제거", "モザイク除去", "モザイク破壊", "AI修復", "漏れ", "Mosaic Removed", "Decensored", "Uncensored Leaked", "AI Uncensored", "去码", "破码", "AI修复", "AI去码", "Hapus Sensor", "Hilangkan Sensor", "AI No Sensor", "Buang Sensor", "去碼", "破碼", "AI去碼", "ลบเซ็นเซอร์", "ถอดเซ็นเซอร์", "AI ลบเซ็นเซอร์", "Xóa Che", "Gỡ Che", "AI Xóa Che"],
    fc2: ["FC2 추천해줘", "fc2", "FC2の作品", "给我 FC2"],
  };
  for (const [list, texts] of Object.entries(cases)) for (const text of texts) assert.strictEqual(detect(text), list, `${list}: ${text}`);
});

test("a longer keyword wins over the shorter one it contains; case and spacing are ignored; a category beats the plain word", () => {
  assert.strictEqual(detect("AI Uncensored"), "leaked"); // contains "Uncensored"
  assert.strictEqual(detect("Uncensored Leaked 보여줘"), "leaked");
  assert.strictEqual(detect("AI No Sensor"), "leaked"); // contains "No Sensor"
  assert.strictEqual(detect("AI去码"), "leaked");
  assert.strictEqual(detect("原版无码"), "uncensored");
  assert.strictEqual(detect("모자이크파괴 추천"), "leaked"); // no space
  assert.strictEqual(detect("UNCENSORED"), "uncensored");
  assert.strictEqual(detect("노모 품번 알려줘"), "uncensored");
  assert.strictEqual(detect("FC2 product code"), "fc2");
  // same length: the one named first
  assert.strictEqual(detect("FC2 노모"), "fc2");
});

test("five titles, most favourited first; each code links to its movie id with images; the actress name is shown", async () => {
  const q = fakeCollections(movies(8), { actresses: [{ person_id: "p1", name: "日本名", also_known_as: { kr: "한국이름", jp: "日本名", en: "English Name" } }] });
  const out = await productList.buildReply({}, "ko", "all");
  assert.deepStrictEqual(out.links.map((l) => l.title), ["ABC-100", "ABC-101", "ABC-102", "ABC-103", "ABC-104"]);
  for (const l of out.links) {
    assert.strictEqual(out.text.slice(l.start, l.end), l.title);
    assert.strictEqual(l.type, "av");
    assert.ok(l.movie_id.startsWith("id"));
    assert.strictEqual(l.year, 2024);
    assert.match(l.thumbnail, /thumbs/);
    assert.match(l.cover, /covers/);
  }
  assert.ok(out.text.includes("ABC-100 - 한국이름"));
  assert.ok(out.text.startsWith("User's Pick 작품 중"));
  assert.deepStrictEqual(out.cursor, { fav: 996, id: "id004" });
  assert.strictEqual(out.reset, false);
  // every active title with a favourite_count (not only a featured set), most favourited first
  assert.deepStrictEqual(q[0].sort, { favorite_count: -1, _id: -1 });
  assert.deepStrictEqual(q[0].filter.favorite_count, { $gt: 0 });
  assert.strictEqual(q[0].filter.is_active, 1);
  assert.strictEqual(q[0].filter.seeding_favorite, undefined);
  assert.strictEqual(q[0].filter.category_id, undefined);
});

test("a category list: only that category, the issue's condition (favorite_count exists, is_active 1), named in the intro", async () => {
  const list = [...movies(4, (i) => 900 - i, "5f7592975c425008d254a789"), ...movies(4, (i) => 950 - i, "606d1f633a5281073f6c18b4").map((m, i) => ({ ...m, _id: `fc${i}`, title: `FC2-PPV-${i}` }))];
  const q = fakeCollections(list);
  const out = await productList.buildReply({}, "en", "uncensored");
  assert.deepStrictEqual(out.links.map((l) => l.title), ["ABC-100", "ABC-101", "ABC-102", "ABC-103"]);
  assert.deepStrictEqual(q[0].filter.favorite_count, { $exists: true });
  assert.strictEqual(q[0].filter.category_id, "5f7592975c425008d254a789");
  assert.strictEqual(q[0].filter.is_active, 1);
  assert.deepStrictEqual(q[0].sort, { favorite_count: -1, _id: -1 });
  assert.ok(out.text.startsWith("Here are Uncensored picks"));

  const fc2 = await productList.buildReply({}, "ko", "fc2");
  assert.ok(fc2.links.every((l) => l.title.startsWith("FC2-PPV-")));
  assert.ok(fc2.text.startsWith("FC2 작품 중"));
  const leakedQuery = q.length;
  await productList.buildReply({}, "ja", "leaked");
  assert.strictEqual(q[leakedQuery].filter.category_id, "638ba0b6e6248f567f04b84c");
});

test("each list continues on its own: no repeats, even when many titles share a count", async () => {
  const leakedRows = movies(3, (i) => 500 - i, "638ba0b6e6248f567f04b84c").map((m, i) => ({ ...m, _id: `lk${i}`, title: `LEAK-${i}` }));
  fakeCollections([...movies(12, (i) => (i < 8 ? 50 : 40)), ...leakedRows]); // 8 titles tie on 50
  const seen = [];
  let conv = {};
  for (let round = 0; round < 3; round++) {
    const out = await productList.buildReply(conv, "en", "all");
    seen.push(...out.links.map((l) => l.title));
    conv = { product_cursors: { all: out.cursor } };
  }
  // the plain list covers every category: 12 + 3 titles in three rounds of five
  assert.strictEqual(seen.length, 15);
  assert.strictEqual(new Set(seen).size, 15, "no title twice, none skipped");
  // another list of the same conversation is not affected by where "all" stopped
  const other = await productList.buildReply({ product_cursors: { all: { fav: 1, id: "id000" } } }, "en", "leaked");
  assert.deepStrictEqual(other.links.map((l) => l.title), ["LEAK-0", "LEAK-1", "LEAK-2"]);
});

test("when the list ends it starts over, with a notice", async () => {
  fakeCollections(movies(3));
  const first = await productList.buildReply({}, "en", "all");
  assert.strictEqual(first.links.length, 3);
  const out = await productList.buildReply({ product_cursors: { all: first.cursor } }, "en", "all");
  assert.strictEqual(out.reset, true);
  assert.strictEqual(out.links.length, 3);
  assert.ok(out.text.startsWith(productList.TEXT.en.reset));
});

test("nothing to recommend: a plain message, no links, nothing remembered", async () => {
  fakeCollections([]);
  const out = await productList.buildReply({}, "ja", "all");
  assert.strictEqual(out.text, productList.TEXT.ja.none);
  assert.deepStrictEqual([out.links.length, out.cursor, out.reset], [0, null, false]);
});

test("the plain list without the chat_product_rank index uses the small User's Pick set; a category list needs no fallback", async () => {
  const q = fakeCollections(movies(3), { indexes: [] });
  const out = await productList.buildReply({}, "en", "all");
  assert.strictEqual(out.links.length, 3);
  assert.strictEqual(q[0].filter.seeding_favorite, 1);
  assert.strictEqual(q[0].filter.favorite_count, undefined);
  await productList.buildReply({}, "en", "fc2");
  assert.strictEqual(q[1].filter.seeding_favorite, undefined);
  assert.strictEqual(q[1].filter.category_id, "606d1f633a5281073f6c18b4");
});

test("a broken cursor on the conversation is ignored", async () => {
  fakeCollections(movies(6));
  const out = await productList.buildReply({ product_cursors: { all: { fav: "x" } } }, "en", "all");
  assert.strictEqual(out.links[0].title, "ABC-100");
});

test("the actress name follows the app language and falls back to the name stored on the movie", async () => {
  const aka = { kr: "한국이름", tw: "台灣名", en: "English Name" };
  fakeCollections(movies(1), { actresses: [{ person_id: "p1", name: "日本名", also_known_as: aka }] });
  assert.ok((await productList.buildReply({}, "ko", "all")).text.includes("한국이름"));
  assert.ok((await productList.buildReply({}, "zh-tw", "all")).text.includes("台灣名"));
  assert.ok((await productList.buildReply({}, "th", "all")).text.includes("English Name"));
  fakeCollections(movies(1), { actresses: [] }); // actress not in actress_new
  assert.ok((await productList.buildReply({}, "ko", "all")).text.includes("日本名"));
});

test("every app language has the template texts and a name for each list", () => {
  for (const lang of ["en", "ko", "ja", "zh", "zh-tw", "id", "ms", "ru", "th", "vi"]) {
    for (const key of ["intro", "outro", "reset", "none"]) assert.ok(productList.TEXT[lang][key], `${lang}.${key}`);
    assert.ok(productList.TEXT[lang].intro.includes("{list}"), `${lang} intro names the list`);
    for (const list of ["all", "uncensored", "fc2", "leaked"]) assert.ok(productList.LABELS[lang][list], `${lang}.${list}`);
  }
});

test("a placeholder instead of an actress name is not shown", async () => {
  const list = movies(1).map((m) => ({ ...m, actress: [{ person_id: "p9", name: "Unknown" }, { person_id: "p1", name: "日本名" }] }));
  fakeCollections(list, { actresses: [{ person_id: "p9", name: "Unknown", also_known_as: { en: "Unknown" } }] });
  const out = await productList.buildReply({}, "en", "all");
  assert.ok(!out.text.includes("Unknown"));
  assert.ok(out.text.includes("ABC-100 - 日本名"));
});
