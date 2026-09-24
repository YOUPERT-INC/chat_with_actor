const test = require("node:test");
const assert = require("node:assert");
const { stripLinkBlock, stripModelLinks } = require("../src/linkGuard");
const humor = require("../src/humor");

const POST = { title: '[이갤] "제목" & 특수문자', label: "디시인사이드 실시간 베스트", url: "https://gall.dcinside.com/board/view/?id=dcbest&no=465668" };

test("stripLinkBlock removes exactly the block the server appended (round trip with linkBlock)", () => {
  const spoken = "이거 봐봐 ㅋㅋ 제목부터 웃기지 않아?";
  const stored = spoken + humor.linkBlock(POST);
  assert.strictEqual(stripLinkBlock(stored), spoken);
  assert.strictEqual(stripLinkBlock(spoken), spoken, "text without a block is untouched");
  assert.strictEqual(stripLinkBlock(""), "");
  assert.strictEqual(stripLinkBlock(undefined), "");
});

test("stripLinkBlock only cuts a block at the very end, not a mention in the middle", () => {
  const text = "앞에서 🔗 이라고 썼는데\nhttps://gall.dcinside.com/x 이건 중간이야\n\n그리고 계속 얘기해";
  assert.strictEqual(stripLinkBlock(text), text);
});

test("stripModelLinks: an invented link block (title + address) written by the model is removed", () => {
  const model = '오, 그거 재밌는 거 하나 찾아줄게!\n\n🔗 [이갤] "붕어빵 팔이 이상하다" 실시간 난리 난 이유 (디시인사이드 실시간 베스트)\nhttps://gall.dcinside.com/board/view/?id=dcbest&no=465667\n\n붕어빵 타령하는 제목부터 웃기지 않아 ㅋㅋ';
  const cleaned = stripModelLinks(model);
  assert.ok(!cleaned.includes("http"));
  assert.ok(!cleaned.includes("🔗"));
  assert.ok(!cleaned.includes("붕어빵 팔이 이상하다"), "the invented title line goes too");
  assert.ok(cleaned.includes("오, 그거 재밌는 거 하나 찾아줄게!"));
  assert.ok(cleaned.includes("붕어빵 타령하는 제목부터"));
  assert.ok(!/\n{3,}/.test(cleaned));
});

test("stripModelLinks: markdown links keep their text, bare and www URLs disappear, normal text is untouched", () => {
  assert.strictEqual(stripModelLinks("여기 [디시](https://gall.dcinside.com/x) 봐"), "여기 디시 봐");
  assert.strictEqual(stripModelLinks("주소는 https://evil.example.com/a?b=1&c=2 야"), "주소는 야");
  assert.ok(!stripModelLinks("www.example.com 가봐").includes("example"));
  const plain = "오늘은 칼국수 먹을래? 매운 거 괜찮아?\n\n- 하나\n- 둘";
  assert.strictEqual(stripModelLinks(plain), plain);
  assert.strictEqual(stripModelLinks(""), "");
});

test("the funny-post hint and tool note forbid claiming to have read the post and allow asking for another", () => {
  assert.match(humor.FUNNY_HINT, /asks for another one/);
  assert.match(humor.FUNNY_HINT, /each call gives a NEW post/);
  assert.match(humor.FUNNY_HINT, /never claim you read the post or describe its content, comments or reactions/);
  assert.match(humor.FUNNY_HINT, /Never write a URL or a link line/);
});

test("pickForContext note tells the model it has only seen the title", async () => {
  const store = {
    async candidates(source) {
      return source === "dcbest" ? [{ post_id: "1", post_num: 1, title: "제목", url: "https://gall.dcinside.com/board/view/?id=dcbest&no=1" }] : [];
    },
  };
  const r = await humor.pickForContext({ lang: "ko", sharedUrls: new Set(), picked: [] }, { store });
  assert.match(r.note, /only seen this title/);
  assert.match(r.note, /do not claim to have read the post/);
  assert.ok(!JSON.stringify(r).includes("http"));
});
