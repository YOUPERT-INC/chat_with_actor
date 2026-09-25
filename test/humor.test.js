const test = require("node:test");
const assert = require("node:assert");
const humor = require("../src/humor");
const tools = require("../src/tools");

// ---- fixtures modelled on the real pages (2026-09-24) ----
const dcRow = (no, title, { views = 1000, rec = 10, num = String(no), type = "icon_txt" } = {}) => `
<tr class="ub-content us-post" data-no="${no}" data-type="${type}">
  <td class="gall_num">${num}</td>
  <td class="gall_tit ub-word">
    <a href="/board/view/?id=dcbest&no=${no}&_dcbest=1&page=1" view-msg=""><em class="icon_img ${type}"></em>${title}</a>
    <a class="reply_numbox" href="https://gall.dcinside.com/board/view/?id=dcbest&no=${no}&t=cv"><span class="reply_num">[3]</span></a>
  </td>
  <td class="gall_writer ub-writer" data-nick="x"><b>x</b></td>
  <td class="gall_date" title="2026-09-24 10:00:00">10:00</td>
  <td class="gall_count">${views}</td>
  <td class="gall_recommend">${rec}</td>
</tr>`;
const DC_HTML = `<html><table>
<tr class="ub-content "> <td class="gall_num">설문</td> <td class="gall_tit ub-word"><a href="javascript:;" onclick="survey_layer('x')"><b>설문 제목</b></a></td> <td class="gall_count">-</td> <td class="gall_recommend">-</td> </tr>
<tr class="ub-content" data-no="30638" data-type="icon_notice" > <td class="gall_num">공지</td> <td class="gall_tit ub-word"> <a href="/board/view/?id=dcbest&no=30638"><b><b>실시간베스트 갤러리 이용 안내</b></b></a></td> <td class="gall_count">16458112</td> <td class="gall_recommend">914</td> </tr>
${dcRow(465665, "[이갤] 서양 커뮤에서 만든 &quot;인종&quot; 순위 20단계", { views: 2171, rec: 11 })}
${dcRow(465663, "[해갤] 손흥민 개쩌는 프리킥 &amp; 추가골...gif", { views: 12295, rec: 369, type: "icon_pic" })}
${dcRow(465661, "<b>[싱갤]</b> 싱글벙글 썩차로   신차 만들기", { views: 9684, rec: 28 })}
</table></html>`;

const PP_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"><channel><title>뽐뿌</title>
<item><title>실시간으로 욕먹는 사람</title><link>http://www.ppomppu.co.kr/zboard/view.php?id=humor&amp;no=783244</link><author>a</author><pubDate>Thu, 24 Sep 2026 07:28:54 GMT</pubDate><hits> [0|73|0|0]</hits></item>
<item><title><![CDATA[미국 고등학생들의 이상형 &amp; 그 이유]]></title><link>http://www.ppomppu.co.kr/zboard/view.php?id=humor&amp;no=783243</link><description>x</description><hits> [1|369|2|0]</hits></item>
<item><title>링크 없는 항목</title><hits> [0|1|0|0]</hits></item>
</channel></rss>`;

test("parseDcBest: real posts only (survey and notice rows skipped), clean titles and canonical links", () => {
  const posts = humor.parseDcBest(DC_HTML);
  assert.deepStrictEqual(posts.map((p) => p.post_id), ["465665", "465663", "465661"]);
  assert.strictEqual(posts[0].title, '[이갤] 서양 커뮤에서 만든 "인종" 순위 20단계');
  assert.strictEqual(posts[1].title, "[해갤] 손흥민 개쩌는 프리킥 & 추가골...gif");
  assert.strictEqual(posts[2].title, "[싱갤] 싱글벙글 썩차로 신차 만들기", "tags removed, whitespace collapsed");
  assert.strictEqual(posts[0].url, "https://gall.dcinside.com/board/view/?id=dcbest&no=465665");
  assert.strictEqual(posts[1].views, 12295);
  assert.strictEqual(posts[1].recs, 369);
  assert.strictEqual(posts[0].post_num, 465665);
});

test("parseDcBest: an unrecognised page gives no posts (never a crash)", () => {
  assert.deepStrictEqual(humor.parseDcBest("<html>보안 시스템</html>"), []);
  assert.deepStrictEqual(humor.parseDcBest(""), []);
});

test("parsePpomppuRss: title, https link, views (2nd number), CDATA and entities handled; items without a link dropped", () => {
  const posts = humor.parsePpomppuRss(PP_XML);
  assert.deepStrictEqual(posts.map((p) => p.post_id), ["783244", "783243"]);
  assert.strictEqual(posts[0].url, "https://www.ppomppu.co.kr/zboard/view.php?id=humor&no=783244");
  assert.strictEqual(posts[0].views, 73);
  assert.strictEqual(posts[1].title, "미국 고등학생들의 이상형 & 그 이유");
  assert.strictEqual(posts[1].views, 369);
  assert.strictEqual(posts[1].recs, 2);
});

test("isAllowedUrl: https on the two allowed hosts only", () => {
  assert.ok(humor.isAllowedUrl("https://gall.dcinside.com/board/view/?id=dcbest&no=1"));
  assert.ok(humor.isAllowedUrl("https://www.ppomppu.co.kr/zboard/view.php?id=humor&no=1"));
  for (const bad of ["http://gall.dcinside.com/x", "https://evil.example.com/x", "https://gall.dcinside.com.evil.com/x", "javascript:alert(1)", "https://user@evil.com@gall.dcinside.com.evil.com/", "not a url", ""]) {
    assert.ok(!humor.isAllowedUrl(bad), bad);
  }
});

// ---- in-memory store ----
function memoryStore() {
  const rows = [];
  return {
    rows,
    async upsert(source, posts, now) {
      let added = 0;
      for (const p of posts) {
        const found = rows.find((r) => r.source === source && r.post_id === p.post_id);
        if (found) Object.assign(found, { views: p.views, recs: p.recs });
        else { rows.push({ source, first_seen: now, ...p }); added++; }
      }
      return added;
    },
    async candidates(source, { sinceMs = 0, sort, limit }) {
      let list = rows.filter((r) => r.source === source && (!sinceMs || r.first_seen.getTime() >= Date.now() - sinceMs));
      const [key, dir] = Object.entries(sort)[0];
      list = list.sort((a, b) => (b[key] - a[key]) * (dir === -1 ? 1 : -1));
      return list.slice(0, limit);
    },
  };
}
const response = (status, data) => ({ get: async () => ({ status, data }) });

test("refreshSource: stores parsed posts and reports what was new; the same page again adds nothing", async () => {
  humor._resetHealth();
  const store = memoryStore();
  const dc = humor.SOURCES.find((s) => s.id === "dcbest");
  const first = await humor.refreshSource(dc, { store, http: response(200, DC_HTML) });
  assert.deepStrictEqual([first.parsed, first.added], [3, 3]);
  const second = await humor.refreshSource(dc, { store, http: response(200, DC_HTML), now: () => Date.now() });
  assert.strictEqual(second.added, 0);
  assert.strictEqual(store.rows.length, 3);
});

test("refreshSource: a site that answers anything but 200 (403 / 430 / redirect page) is backed off, never retried or worked around", async () => {
  humor._resetHealth();
  const store = memoryStore();
  const dc = humor.SOURCES.find((s) => s.id === "dcbest");
  let calls = 0;
  const blocked = { get: async () => { calls++; return { status: 430, data: "보안 시스템" }; } };
  let t = 1_000_000;
  const now = () => t;
  assert.ok((await humor.refreshSource(dc, { store, http: blocked, now })).error);
  assert.strictEqual(calls, 1);
  t += 5 * 60 * 1000; // 5 min later: still backing off
  assert.strictEqual((await humor.refreshSource(dc, { store, http: blocked, now })).skipped, "backoff");
  assert.strictEqual(calls, 1, "no request while backing off");
  t += 6 * 60 * 1000; // > 10 min: one more try, then the wait doubles
  await humor.refreshSource(dc, { store, http: blocked, now });
  assert.strictEqual(calls, 2);
  t += 15 * 60 * 1000; // 15 min < 20 min wait
  assert.strictEqual((await humor.refreshSource(dc, { store, http: blocked, now })).skipped, "backoff");
  assert.strictEqual(store.rows.length, 0);
});

test("refreshSource: a page that parses to nothing counts as a failure (layout changed), and success resets the backoff", async () => {
  humor._resetHealth();
  const store = memoryStore();
  const dc = humor.SOURCES.find((s) => s.id === "dcbest");
  let t = 5_000_000;
  const now = () => t;
  assert.ok((await humor.refreshSource(dc, { store, http: response(200, "<html>changed</html>"), now })).error);
  t += 11 * 60 * 1000;
  const ok = await humor.refreshSource(dc, { store, http: response(200, DC_HTML), now });
  assert.strictEqual(ok.added, 3);
  t += 1000; // success reset the backoff: the next scheduled run is allowed immediately
  assert.ok(!(await humor.refreshSource(dc, { store, http: response(200, DC_HTML), now })).skipped);
});

test("refreshSource: links outside the allowed hosts never reach the store", async () => {
  humor._resetHealth();
  const store = memoryStore();
  const pp = humor.SOURCES.find((s) => s.id === "ppomppu");
  const xml = `<rss><channel><item><title>x</title><link>https://evil.example.com/view.php?id=humor&amp;no=1</link><hits>[0|5|0|0]</hits></item></channel></rss>`;
  const r = await humor.refreshSource(pp, { store, http: response(200, xml) });
  assert.ok(r.error, "nothing usable parsed -> failure");
  assert.strictEqual(store.rows.length, 0);
});

test("pickPost: DCInside first and newest first; already-sent links are skipped; Ppomppu (most viewed) only when DC is used up", async () => {
  const store = memoryStore();
  const now = new Date();
  await store.upsert("dcbest", humor.parseDcBest(DC_HTML), now);
  await store.upsert("ppomppu", humor.parsePpomppuRss(PP_XML), now);

  const exclude = new Set();
  const order = [];
  for (let i = 0; i < 6; i++) {
    const p = await humor.pickPost({ exclude, store });
    if (!p) break;
    order.push(`${p.source}:${p.url.match(/no=(\d+)/)[1]}`);
    exclude.add(p.url);
  }
  assert.deepStrictEqual(order, ["dcbest:465665", "dcbest:465663", "dcbest:465661", "ppomppu:783243", "ppomppu:783244"]);
  assert.strictEqual(await humor.pickPost({ exclude, store }), null, "everything sent: nothing left, not a repeat");
});

test("pickPost: Ppomppu only offers the last 24 hours", async () => {
  const store = memoryStore();
  await store.upsert("ppomppu", humor.parsePpomppuRss(PP_XML), new Date(Date.now() - 30 * 3600 * 1000));
  assert.strictEqual(await humor.pickPost({ exclude: new Set(), store }), null);
});

test("pickForContext: Korean users only, one link per message, no repeats, the model gets title and source but never the address", async () => {
  const store = memoryStore();
  await store.upsert("dcbest", humor.parseDcBest(DC_HTML), new Date());
  const ctx = () => ({ lang: "ko", sharedUrls: new Set(), picked: [] });

  assert.strictEqual((await humor.pickForContext({ lang: "en", sharedUrls: new Set(), picked: [] }, { store })).error, "unavailable");

  const c = ctx();
  const r = await humor.pickForContext(c, { store });
  assert.strictEqual(r.source, "디시인사이드 실시간 베스트");
  assert.ok(r.title.startsWith("[이갤]"));
  assert.ok(!JSON.stringify(r).includes("http"), "no URL is handed to the model");
  assert.match(r.note, /do not write any URL or link line/);
  assert.strictEqual(c.picked.length, 1);

  const again = await humor.pickForContext(c, { store });
  assert.strictEqual(again.error, "already_shared", "one link per message");
  assert.strictEqual(c.picked.length, 1);

  const c2 = { lang: "ko", sharedUrls: new Set([c.picked[0].url]), picked: [] };
  const next = await humor.pickForContext(c2, { store });
  assert.ok(next.title.startsWith("[해갤]"), "the next conversation turn gets the next newest post");

  const empty = await humor.pickForContext({ lang: "ko", sharedUrls: new Set(), picked: [] }, { store: memoryStore() });
  assert.strictEqual(empty.error, "none");
});

test("linkBlock: title and source on one line, the address alone on the next (so the app can make it tappable)", () => {
  const block = humor.linkBlock({ title: "제목", label: "뽐뿌 유머/감동", url: "https://www.ppomppu.co.kr/zboard/view.php?id=humor&no=1" });
  assert.strictEqual(block, "\n\n🔗 제목 (뽐뿌 유머/감동)\nhttps://www.ppomppu.co.kr/zboard/view.php?id=humor&no=1");
});

test("the funny-post tool is offered to Korean-language users only, and only there is the hint added", () => {
  assert.deepStrictEqual(tools.toolDefsFor({ lang: "en" }).map((t) => t.function.name), ["get_titles"]);
  assert.deepStrictEqual(tools.toolDefsFor({ lang: "ko" }).map((t) => t.function.name), ["get_titles", "get_funny_post"]);
  assert.deepStrictEqual(tools.toolDefsFor({ lang: "zh" }).length, 1);
  assert.ok(humor.isEligible("KO") && !humor.isEligible("ja") && !humor.isEligible(undefined));
  assert.match(humor.FUNNY_HINT, /Never call it unprompted/);
  assert.match(humor.FUNNY_HINT, /Never write a URL or a link line/);
  assert.match(tools.FUNNY_TOOL.function.description, /never use it unprompted|Never use it unprompted/i);
});

test("runTool routes get_funny_post and never throws when there is nothing to share", async () => {
  const ctx = { lang: "en", sharedUrls: new Set(), picked: [] };
  assert.strictEqual((await tools.runTool("get_funny_post", "{}", ctx)).error, "unavailable");
});

// ---- the server decides on clear requests ----

test("wantsFunnyPost: requests for something funny / boredom / community talk, and 'another one' right after a link", () => {
  for (const yes of ["심심해ㅠㅠ 웃긴 거 없어?", "웃긴 글 하나만 보여줘", "재밌는 거 없어?", "요즘 커뮤니티에서 뭐가 제일 웃겨?", "커뮤 뭐 올라왔어", "웃긴 짤 없어?", "아 심심하다"]) {
    assert.ok(humor.wantsFunnyPost(yes), yes);
  }
  for (const yes of ["또 다른 거 없어?", "하나만 더!", "다음거", "더 없어?", "한 번 더 줘"]) {
    assert.ok(humor.wantsFunnyPost(yes, { afterLink: true }), yes + " (after a link)");
    assert.ok(!humor.wantsFunnyPost(yes, { afterLink: false }), yes + " (no link before: not about links)");
  }
});

test("wantsFunnyPost: ordinary talk and 'tell me a joke' do not trigger a link", () => {
  for (const no of ["안녕! 오늘 뭐해?", "오늘 저녁 뭐 먹지", "웃긴 얘기 해줘", "농담 하나 해봐", "개그 좀 해줘", "영화 추천해줘", "고마워 ㅋㅋ", ""]) {
    assert.ok(!humor.wantsFunnyPost(no, { afterLink: true }), no);
  }
  assert.ok(!humor.wantsFunnyPost("이 문장은 아주 길어서 그냥 잡담이고 또 다른 얘기를 하고 있으며 링크와는 상관이 없는 이야기입니다", { afterLink: true }), "long chatty message after a link");
});

test("funnyNote: with a post it names the title and forbids URLs and invented content; without one it forbids inventing a post", () => {
  const note = humor.funnyNote({ title: "제목", label: "뽐뿌 유머/감동", url: "https://www.ppomppu.co.kr/x" });
  assert.match(note, /"제목" \(뽐뿌 유머\/감동\)/);
  assert.match(note, /do not write any URL or link line/);
  assert.match(note, /do not claim to have read the post/);
  assert.ok(!note.includes("http"), "the address stays on the server");
  const none = humor.funnyNote(null);
  assert.match(none, /no new one to share/);
  assert.match(none, /Do not make up any post, title or link/);
});

// ---- drafts that claim a post the app never gave ----

test("claimsPost: catches 'I found / brought a post' style claims, leaves normal talk alone", () => {
  for (const yes of [
    "하나 더 찾아왔어, 호그와트 기숙사별 그리핀도르 맥락이라는 제목인데 ㅋㅋ",
    "또 하나 가져왔어! 이번엔 '42살에 컴퓨터공학 석사 도전한 후기 2탄'이라는 글이야.",
    "방금 올라온 글 중에 이런 게 있네 ㅋㅋ",
    "제목이 이래, 한번 봐봐",
    "오늘 실시간 베스트에서 이 글 가져와 봤어",
  ]) {
    assert.ok(humor.claimsPost(yes), yes);
  }
  for (const no of [
    "아쉽게도 지금은 새로 가져올 만한 게 없네ㅠ",
    "오늘 저녁은 김치찌개 끓일까 고민 중이야",
    "커피 가져왔어? 나도 한 잔 줘",
    "글쎄, 나는 잘 모르겠어",
    "",
  ]) {
    assert.ok(!humor.claimsPost(no), no);
  }
  assert.match(humor.NO_CLAIM_NOTE, /WITHOUT claiming to have found, fetched or seen any post/);
});

test("the hint forbids saying a post was found unless the app gave one", () => {
  assert.match(humor.FUNNY_HINT, /never say you found, fetched, brought or saw a post unless the app gave you one in this very message/);
});
