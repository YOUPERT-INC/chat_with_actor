const axios = require("axios");
const config = require("./config");

/**
 * @param {{role: string, content: string}[]} messages
 * @returns {Promise<{text: string, finishReason: string, usage: object|undefined}>}
 */
async function chat(messages) {
  if (!config.deepseekKey) throw new Error("DEEPSEEK_API_KEY is not set");
  const resp = await axios.post(
    config.deepseekUrl,
    {
      model: config.deepseekModel,
      messages,
      temperature: 1.0,
      max_tokens: config.maxOutputTokens,
      stream: false,
    },
    {
      headers: { Authorization: `Bearer ${config.deepseekKey}` },
      timeout: 60000,
    }
  );
  const choice = resp.data && resp.data.choices && resp.data.choices[0];
  const text = choice && choice.message && choice.message.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("empty model response");
  return { text: text.trim(), finishReason: choice.finish_reason, usage: resp.data.usage };
}

module.exports = { chat };
