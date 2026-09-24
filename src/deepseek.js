const axios = require("axios");
const config = require("./config");

const MAX_PARALLEL_TOOLS = 4;

/**
 * One model call.
 * @param {object[]} messages  chat messages (may include assistant tool_calls / role "tool")
 * @param {{tools?: object[]}} options  tool definitions the model may call
 * @returns {Promise<{text: string, toolCalls: object[], message: object, finishReason: string, usage: object|undefined}>}
 *   `text` is empty exactly when the model asked for tools instead of answering.
 */
async function chat(messages, { tools } = {}) {
  if (!config.deepseekKey) throw new Error("DEEPSEEK_API_KEY is not set");
  const resp = await axios.post(
    config.deepseekUrl,
    {
      model: config.deepseekModel,
      messages,
      temperature: 1.0,
      max_tokens: config.maxOutputTokens,
      // deepseek-flash thinks by default (effort "high"): the hidden reasoning is billed as
      // output and counts against max_tokens, so it can eat the whole budget and leave an
      // empty reply. A chat line needs no reasoning.
      thinking: { type: "disabled" },
      ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
      stream: false,
    },
    {
      headers: { Authorization: `Bearer ${config.deepseekKey}` },
      timeout: 60000,
    }
  );
  const usage = resp.data && resp.data.usage;
  if (usage) {
    console.log(`[deepseek] in=${usage.prompt_tokens} cached=${usage.prompt_cache_hit_tokens} out=${usage.completion_tokens}`);
  }
  const choice = resp.data && resp.data.choices && resp.data.choices[0];
  const message = (choice && choice.message) || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const text = typeof message.content === "string" ? message.content.trim() : "";
  if (!toolCalls.length && !text) throw new Error("empty model response");
  return { text, toolCalls, message, finishReason: choice && choice.finish_reason, usage };
}

/**
 * A chat turn that may use tools: the model can ask for tool results (at most `maxRounds`
 * times, in parallel within a round), then must answer in words. The last call is made without
 * tools so a final answer is always produced.
 *
 * @param {object[]} messages
 * @param {{tools?: object[], runTool?: (name: string, args: string, ctx: object) => Promise<object>,
 *          context?: object, maxRounds?: number, call?: Function}} options  `call` = chat (injectable for tests)
 * @returns {Promise<{text: string, finishReason: string, usage: object|undefined, toolsUsed: string[]}>}
 */
async function converse(messages, { tools, runTool, context = {}, maxRounds = 2, call = chat } = {}) {
  const conversation = [...messages];
  const toolsUsed = [];
  for (let round = 0; round <= maxRounds; round++) {
    const withTools = tools && tools.length && runTool && round < maxRounds;
    const result = await call(conversation, withTools ? { tools } : {});
    if (!result.toolCalls.length) return { ...result, toolsUsed };

    conversation.push({ role: "assistant", content: result.message.content || null, tool_calls: result.toolCalls });
    // every tool_call must be answered, but only the first few are actually run
    const outputs = await Promise.all(
      result.toolCalls.map(async (tc, i) => {
        if (i >= MAX_PARALLEL_TOOLS) return { error: "skipped", note: "too many lookups at once; answer with what you have" };
        toolsUsed.push(tc.function.name);
        return runTool(tc.function.name, tc.function.arguments, context);
      })
    );
    result.toolCalls.forEach((tc, i) => {
      conversation.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(outputs[i]) });
    });
  }
  // only reachable if the final, tool-less call still asked for tools
  throw new Error("model kept asking for tools");
}

module.exports = { chat, converse };
