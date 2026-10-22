import OpenAI from "openai";
import { env } from "./env.mjs";

// Keep OpenAI request and response details inside this adapter. Usage follows
// the fields consumed by the existing room UI; unsupported cache fields remain 0.
export const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let client;
function apiClient() {
  if (!client) client = new OpenAI({ apiKey: env("OPENAI_API_KEY"), maxRetries: 0, timeout: 120_000 });
  return client;
}

function addUsage(value = {}) {
  usage.input += value.input_tokens || 0;
  usage.output += value.output_tokens || 0;
  usage.cacheRead += value.input_tokens_details?.cached_tokens || 0;
  usage.calls += 1;
}

function input(messages) {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}
function instructions(system) {
  if (typeof system === "string") return system;
  return (system || []).map((block) => typeof block === "string" ? block : block.text || "").filter(Boolean).join("\n\n");
}

function fail(err) {
  const status = err?.status;
  const message = err?.message || String(err);
  if (status === 401) throw new Error("OpenAI authentication failed. Check OPENAI_API_KEY and API access for this account.");
  if (status === 403) throw new Error("OpenAI denied this request. Check API project permissions and model access.");
  if (status === 404 || err?.code === "model_not_found") throw new Error("OpenAI could not find that model. Check OPENAI_MODEL and model access for this API account.");
  if (status === 400 && /model.*(not found|does not exist|unavailable)/i.test(message)) {
    throw new Error("OpenAI could not find that model. Check OPENAI_MODEL and model access for this API account.");
  }
  if (status === 429) throw new Error("OpenAI rate limit or quota error. Check your API project limits and billing, then retry.");
  if (status >= 500) throw new Error(`OpenAI service error (${status}). Try again later.`);
  if (err?.name === "APIConnectionTimeoutError" || err?.name === "APIConnectionError") {
    throw new Error("Could not reach the OpenAI API before the request timed out. Check the network and retry.");
  }
  // SDK messages can contain request data in some errors; don't return raw
  // server messages to browsers or session files.
  throw new Error(`OpenAI request failed${status ? ` (${status})` : ""}: ${message.slice(0, 180)}`);
}

async function request(makeRequest) {
  for (let attempt = 0; ; attempt++) {
    try { return await makeRequest(); }
    catch (err) {
      const quotaFailure = err?.code === "insufficient_quota" || err?.code === "billing_not_active";
      if (RETRYABLE.has(err?.status) && !quotaFailure && attempt < 2) {
        await sleep(1000 * (2 ** attempt));
        continue;
      }
      fail(err);
    }
  }
}

export function createOpenAIProvider(api) {
  return {
    async stream({ model, system, messages, maxTokens = 2000, onText = () => {} }) {
      const stream = await request(() => api.responses.create({
        model, instructions: instructions(system), input: input(messages), max_output_tokens: maxTokens, stream: true,
      }));
      let text = "";
      let finalUsage = null;
      try {
        for await (const event of stream) {
          if (event.type === "response.output_text.delta") {
            text += event.delta;
            onText(event.delta);
          } else if (event.type === "response.completed") {
            finalUsage = event.response?.usage || finalUsage;
          } else if (event.type === "response.failed" || event.type === "error") {
            const err = event.response?.error || event.error || {};
            throw new Error(`OpenAI response failed${err.code ? ` (${err.code})` : ""}. Check the model, API limits, and request.`);
          }
        }
      } catch (err) {
        if (/^OpenAI response failed/.test(err?.message || "")) throw err;
        fail(err);
      }
      if (!text.trim()) throw new Error("OpenAI returned an empty response. Retry the council.");
      addUsage(finalUsage || {});
      return text;
    },

    async json({ model, system, prompt, schema, maxTokens = 4000 }) {
      const response = await request(() => api.responses.create({
        model,
        instructions: instructions(system),
        input: prompt,
        max_output_tokens: maxTokens,
        text: { format: { type: "json_schema", name: "council_output", strict: true, schema } },
      }));
      addUsage(response.usage || {});
      if (response.status === "incomplete") {
        throw new Error(`Chair output was incomplete${response.incomplete_details?.reason === "max_output_tokens" ? " because it reached max_output_tokens" : ""}.`);
      }
      const text = response.output_text;
      if (!text?.trim()) throw new Error("OpenAI returned an empty structured response. Retry the council.");
      try { return JSON.parse(text); }
      catch { throw new Error("OpenAI returned invalid JSON for a structured Chair response. Retry the council."); }
    },
  };
}

const provider = createOpenAIProvider({
  responses: { create: (...args) => apiClient().responses.create(...args) },
});
export const stream = (...args) => provider.stream(...args);
export const json = (...args) => provider.json(...args);
