const test = require("node:test");
const assert = require("node:assert");
const db = require("../src/db");
const productList = require("../src/productList");

const realMovies = db.movies;
const realActresses = db.actresses;
test.afterEach(() => {
  db.movies = realMovies;
  db.actresses = realActresses;
});

// a fake `movie` collection: honours the filter parts productList uses (_id $nin) and its sort/limit
function fakeCollections(list, actresses = []) {
  const seenQueries = [];
  db.movies = () => ({
    find: (filter, opts) => {
      seenQueries.push({ filter, opts });
      let rows = list.filter((m) => !(filter._id && filter._id.$nin.some((id) => String(id) === String(m._id))));
      const cursor = {
        sort: (s) => {
          seenQueries[seenQueries.length - 1].sort = s;
          rows = [...rows].sort((a, b) => b.favorite_count - a.favorite_count);
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
  return seenQueries;
}
const movies = (n) => Array.from({ length: n }, (_, i) => ({ _id: `id${i}`, title: `ABC-${100 + i}`, favorite_count: 1000 - i, actress: [{ person_id: "p1", name: "日本名" }] }));

test("the keyword is recognised in every app language, anywhere in the message", () => {
  for (const text of ["품번 알려줘", "추천 품번 좀", "品番を教えて", "给我番号", "給我番號", "give me a product code", "catalog number please", "kode produk dong", "nomor produk", "kod produk", "nombor produk", "дай артикул", "код продукта", "ขอรหัสสินค้า", "cho mình mã sản phẩm"]) {
    assert.ok(productList.wantsProductList(text), text);
  }
  for (const text of ["영화 추천해 줘", "안녕", "what is your code of conduct", "", undefined]) {
    assert.ok(!productList.wantsProductList(text), String(text));
  }
});

test("five titles, most favourited first; each code is a link to its movie id; the actress name is shown", async () => {
  fakeCollections(movies(8), [{ person_id: "p1", name: "日本名", also_known_as: { kr: "한국이름", jp: "日本名", en: "English Name" } }]);
  const out = await productList.buildReply({}, "ko");
  assert.strictEqual(out.links.length, 5);
  assert.deepStrictEqual(out.links.map((l) => l.title), ["ABC-100", "ABC-101", "ABC-102", "ABC-103", "ABC-104"]);
  for (const l of out.links) {
    assert.strictEqual(out.text.slice(l.start, l.end), l.title);
    assert.strictEqual(l.type, "av");
    assert.ok(l.movie_id.startsWith("id"));
  }
  assert.ok(out.text.includes("ABC-100 - 한국이름"));
  assert.ok(out.text.startsWith("User's Pick"));
  assert.deepStrictEqual(out.ids, ["id0", "id1", "id2", "id3", "id4"]);
  assert.strictEqual(out.reset, false);
});

test("titles already recommended in the conversation are skipped", async () => {
  const q = fakeCollections(movies(8));
  const out = await productList.buildReply({ recommended_movies: ["id0", "id1", "id2", "id3", "id4"] }, "en");
  assert.deepStrictEqual(out.links.map((l) => l.title), ["ABC-105", "ABC-106", "ABC-107"]);
  assert.deepStrictEqual(q[0].filter._id.$nin, ["id0", "id1", "id2", "id3", "id4"]);
  assert.deepStrictEqual(q[0].sort, { favorite_count: -1, seeding_favorite_time: -1 });
  assert.strictEqual(q[0].filter.seeding_favorite, 1);
  assert.strictEqual(q[0].filter.is_active, 1);
});

test("when everything was recommended the list starts over, with a notice", async () => {
  fakeCollections(movies(3));
  const out = await productList.buildReply({ recommended_movies: ["id0", "id1", "id2"] }, "en");
  assert.strictEqual(out.reset, true);
  assert.strictEqual(out.links.length, 3);
  assert.ok(out.text.startsWith(productList.TEXT.en.reset));
});

test("nothing to recommend: a plain message, no links, nothing remembered", async () => {
  fakeCollections([]);
  const out = await productList.buildReply({}, "ja");
  assert.strictEqual(out.text, productList.TEXT.ja.none);
  assert.deepStrictEqual([out.links.length, out.ids.length, out.reset], [0, 0, false]);
});

test("the actress name follows the app language and falls back to the name stored on the movie", async () => {
  fakeCollections(movies(1), [{ person_id: "p1", name: "日本名", also_known_as: { kr: "한국이름", tw: "台灣名", en: "English Name" } }]);
  assert.ok((await productList.buildReply({}, "ko")).text.includes("한국이름"));
  assert.ok((await productList.buildReply({}, "zh-tw")).text.includes("台灣名"));
  assert.ok((await productList.buildReply({}, "th")).text.includes("English Name"));
  fakeCollections(movies(1), []); // actress not in actress_new
  assert.ok((await productList.buildReply({}, "ko")).text.includes("日本名"));
});

test("every app language has the four template texts", () => {
  for (const lang of ["en", "ko", "ja", "zh", "zh-tw", "id", "ms", "ru", "th", "vi"]) {
    for (const key of ["intro", "outro", "reset", "none"]) assert.ok(productList.TEXT[lang][key], `${lang}.${key}`);
  }
});
