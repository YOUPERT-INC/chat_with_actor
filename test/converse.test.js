const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const config = require("../src/config");
const deepseek = require("../src/deepseek");
const tools = require("../src/tools");
const catalog = require("../src/catalog");

const toolCall = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

test("converse: a plain answer needs no tool round", async () => {
  const seenTools = [];
  const call = async (msgs, opts) => {
    seenTools.push(opts.tools);
    return { text: "안녕!", toolCalls: [], message: {}, finishReason: "stop" };
  };
  const r = await deepseek.converse([{ role: "user", content: "hi" }], { tools: tools.TOOL_DEFS, runTool: async () => ({}), call });
  assert.strictEqual(r.text, "안녕!");
  assert.deepStrictEqual(r.toolsUsed, []);
  assert.strictEqual(seenTools.length, 1);
  assert.ok(seenTools[0], "tools are offered");
});

test("converse: tool call -> the result goes back to the model -> final answer", async () => {
  const calls = [];
  const call = async (msgs) => {
    calls.push(JSON.parse(JSON.stringify(msgs)));
    if (calls.length === 1) {
      return { text: "", toolCalls: [toolCall("c1", "get_popular_titles", { category: "anime" })], message: { content: null }, finishReason: "tool_calls" };
    }
    return { text: "요즘은 프리렌이 인기야!", toolCalls: [], message: {}, finishReason: "stop" };
  };
  const runs = [];
  const runTool = async (name, args, ctx) => {
    runs.push({ name, args, ctx });
    return { items: [{ title: "Frieren" }] };
  };
  const r = await deepseek.converse([{ role: "user", content: "인기 애니?" }], { tools: tools.TOOL_DEFS, runTool, context: { lang: "ko" }, call });
  assert.strictEqual(r.text, "요즘은 프리렌이 인기야!");
  assert.deepStrictEqual(r.toolsUsed, ["get_popular_titles"]);
  assert.deepStrictEqual(runs[0], { name: "get_popular_titles", args: '{"category":"anime"}', ctx: { lang: "ko" } });
  const second = calls[1];
  assert.strictEqual(second[second.length - 2].role, "assistant");
  assert.strictEqual(second[second.length - 2].tool_calls[0].id, "c1");
  assert.deepStrictEqual(second[second.length - 1], { role: "tool", tool_call_id: "c1", content: JSON.stringify({ items: [{ title: "Frieren" }] }) });
});

test("converse: the last round is made without tools, so an answer is always produced", async () => {
  const offered = [];
  const call = async (msgs, opts) => {
    offered.push(Boolean(opts.tools));
    return offered.length <= 2
      ? { text: "", toolCalls: [toolCall("c" + offered.length, "get_popular_titles", { category: "tv" })], message: {}, finishReason: "tool_calls" }
      : { text: "final", toolCalls: [], message: {}, finishReason: "stop" };
  };
  const r = await deepseek.converse([{ role: "user", content: "x" }], { tools: tools.TOOL_DEFS, runTool: async () => ({}), maxRounds: 2, call });
  assert.strictEqual(r.text, "final");
  assert.deepStrictEqual(offered, [true, true, false]);
  assert.strictEqual(r.toolsUsed.length, 2);
});

test("converse: a model that still asks for tools in the tool-less call is an error, not a loop", async () => {
  const call = async () => ({ text: "", toolCalls: [toolCall("c", "get_popular_titles", {})], message: {}, finishReason: "tool_calls" });
  await assert.rejects(
    deepseek.converse([{ role: "user", content: "x" }], { tools: tools.TOOL_DEFS, runTool: async () => ({}), call }),
    /kept asking/
  );
});

test("runTool never throws: bad JSON, unknown tool and source failures become 'unavailable'", async () => {
  const realGet = catalog.getPopularTitles;
  try {
    assert.strictEqual((await tools.runTool("get_popular_titles", "{not json")).error, "unavailable");
    assert.strictEqual((await tools.runTool("delete_everything", "{}")).error, "unknown tool");
    catalog.getPopularTitles = async () => {
      throw new Error("boom");
    };
    const failed = await tools.runTool("get_popular_titles", '{"category":"anime"}');
    assert.strictEqual(failed.error, "unavailable");
    assert.match(failed.note, /answer from what you know/);
    catalog.getPopularTitles = async (args, ctx) => ({ items: [args, ctx] });
    const ok = await tools.runTool("get_popular_titles", '{"category":"movie"}', { lang: "th" });
    assert.deepStrictEqual(ok.items, [{ category: "movie" }, { lang: "th" }]);
  } finally {
    catalog.getPopularTitles = realGet;
  }
});

test("chat(): sends tools with tool_choice auto, parses tool_calls, still rejects an empty reply", async () => {
  config.deepseekKey = "k";
  const realPost = axios.post;
  try {
    let body;
    axios.post = async (url, b) => {
      body = b;
      return { data: { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [toolCall("z", "get_popular_titles", { category: "movie" })] } }] } };
    };
    const r = await deepseek.chat([{ role: "user", content: "x" }], { tools: tools.TOOL_DEFS });
    assert.strictEqual(body.tool_choice, "auto");
    assert.strictEqual(body.tools.length, tools.TOOL_DEFS.length);
    assert.strictEqual(body.thinking.type, "disabled");
    assert.strictEqual(r.text, "");
    assert.strictEqual(r.toolCalls[0].id, "z");

    axios.post = async (url, b) => {
      body = b;
      return { data: { choices: [{ finish_reason: "stop", message: { content: "ok" } }] } };
    };
    await deepseek.chat([{ role: "user", content: "x" }]);
    assert.ok(!("tools" in body), "no tools param when none are given");

    axios.post = async () => ({ data: { choices: [{ message: { content: "  " } }] } });
    await assert.rejects(deepseek.chat([{ role: "user", content: "x" }]), /empty model response/);
  } finally {
    axios.post = realPost;
    config.deepseekKey = "";
  }
});

test("converse: only the first few parallel tool calls run, but every tool_call still gets an answer", async () => {
  const six = [1, 2, 3, 4, 5, 6].map((i) => toolCall("c" + i, "get_popular_titles", { category: "movie", genre: "Drama", count: i }));
  const seen = [];
  const call = async (msgs) => {
    seen.push(msgs);
    return seen.length === 1 ? { text: "", toolCalls: six, message: {}, finishReason: "tool_calls" } : { text: "done", toolCalls: [], message: {}, finishReason: "stop" };
  };
  let ran = 0;
  const r = await deepseek.converse([{ role: "user", content: "x" }], { tools: tools.TOOL_DEFS, runTool: async () => { ran++; return { ok: true }; }, call });
  assert.strictEqual(ran, 4);
  assert.strictEqual(r.toolsUsed.length, 4);
  const toolMsgs = seen[1].filter((m) => m.role === "tool");
  assert.deepStrictEqual(toolMsgs.map((m) => m.tool_call_id), ["c1", "c2", "c3", "c4", "c5", "c6"]);
  assert.strictEqual(JSON.parse(toolMsgs[5].content).error, "skipped");
});

test("tool definition: default kind is popular, genre and region are offered, top_rated is described as explicit-only", () => {
  const def = tools.TOOL_DEFS[0].function;
  assert.deepStrictEqual(def.parameters.properties.kind.enum, ["popular", "trending", "top_rated"]);
  assert.ok(def.parameters.properties.genre.enum.includes("Romance") && def.parameters.properties.genre.enum.includes("Slice of Life"));
  assert.ok(def.parameters.properties.region);
  assert.match(def.description, /ONLY when the user explicitly asks for the best of all time/);
  assert.match(def.description, /user's own country/);
});

test("both tools are offered and routed by runTool", async () => {
  assert.deepStrictEqual(tools.TOOL_DEFS.map((t) => t.function.name), ["get_popular_titles", "get_catalog_picks"]);
  const real = { p: catalog.getPopularTitles, c: catalog.getCatalogPicks };
  try {
    catalog.getPopularTitles = async () => ({ items: ["chart"] });
    catalog.getCatalogPicks = async (args, ctx) => ({ items: ["catalogue", args, ctx] });
    assert.deepStrictEqual((await tools.runTool("get_popular_titles", "{}")).items, ["chart"]);
    const picks = await tools.runTool("get_catalog_picks", '{"category":"tv"}', { lang: "ko", country: "KR" });
    assert.deepStrictEqual(picks.items, ["catalogue", { category: "tv" }, { lang: "ko", country: "KR" }]);
    assert.match(tools.TOOL_DEFS[1].function.description, /different on every call/);
    assert.match(tools.TOOL_DEFS[1].function.description, /right in this app/);
  } finally {
    catalog.getPopularTitles = real.p;
    catalog.getCatalogPicks = real.c;
  }
});
