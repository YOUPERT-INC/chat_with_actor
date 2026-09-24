const test = require("node:test");
const assert = require("node:assert");
const { trimToLastSentence } = require("../src/text");

test("cuts a half-finished reply back to the last complete sentence", () => {
  assert.strictEqual(trimToLastSentence("오늘은 카페에 갔어. 커피가 맛있었어! 그리고 나는 친구를 만나서 이야"), "오늘은 카페에 갔어. 커피가 맛있었어!");
  assert.strictEqual(trimToLastSentence("I love it. Really! And then we went to the par"), "I love it. Really!");
});

test("a list cut in the middle of an item keeps the complete items", () => {
  const text = "1. Haikyu!! - great teamwork\n2. Nana - so emotional\n3. Mushishi - calm and beau";
  assert.strictEqual(trimToLastSentence(text), "1. Haikyu!! - great teamwork\n2. Nana - so emotional");
});

test("apostrophes and brackets inside a sentence are not sentence ends", () => {
  assert.strictEqual(trimToLastSentence("I'm not sure (maybe) but I'd say it's good. Then I thought it's"), "I'm not sure (maybe) but I'd say it's good.");
});

test("text without any sentence end, or where cutting would lose most of it, is unchanged", () => {
  assert.strictEqual(trimToLastSentence("no ending here"), "no ending here");
  assert.strictEqual(trimToLastSentence("Hi. and then a very long unfinished thought that goes on and on and on"), "Hi. and then a very long unfinished thought that goes on and on and on");
  assert.strictEqual(trimToLastSentence(""), "");
});
