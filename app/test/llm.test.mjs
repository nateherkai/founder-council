import test from "node:test";
import assert from "node:assert/strict";
import { llmModel, llmProvider, normalizeLlmProvider, validateLlmConfig } from "../lib/env.mjs";
import { createOpenAIProvider, usage as openaiUsage } from "../lib/openai.mjs";
import * as anthropic from "../lib/anthropic.mjs";
import { selectProvider } from "../lib/llm.mjs";

test("provider defaults to Anthropic and normalizes case", () => {
  assert.equal(normalizeLlmProvider(""), "anthropic");
  assert.equal(normalizeLlmProvider(" OpenAI "), "openai");
  const old = process.env.LLM_PROVIDER;
  try {
    process.env.LLM_PROVIDER = "OPENAI";
    assert.equal(llmProvider(), "openai");
  } finally {
    if (old === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = old;
  }
});

test("shared LLM boundary selects one provider implementation", () => {
  const anthro = { stream: () => "anthropic" };
  const openai = { stream: () => "openai" };
  assert.equal(selectProvider("anthropic", { anthropic: anthro, openai }), anthro);
  assert.equal(selectProvider("openai", { anthropic: anthro, openai }), openai);
});

test("unsupported providers and selected-provider credentials fail clearly", () => {
  assert.throws(() => normalizeLlmProvider("other"), /LLM_PROVIDER=anthropic or LLM_PROVIDER=openai/);
  const values = {};
  const read = (key) => values[key] || "";
  assert.throws(() => validateLlmConfig("openai", read), /Missing OPENAI_API_KEY/);
  values.OPENAI_API_KEY = "test-key";
  assert.doesNotThrow(() => validateLlmConfig("openai", read));
  assert.throws(() => validateLlmConfig("anthropic", read), /Missing ANTHROPIC_API_KEY/);
});

test("provider-specific model variables and legacy Anthropic role overrides work", () => {
  const values = { SEAT_MODEL: "legacy-seat-model", OPENAI_MODEL: "account-model" };
  const read = (key) => values[key] || "";
  assert.equal(llmModel("seat", "anthropic", read), "legacy-seat-model");
  assert.equal(llmModel("chair", "openai", read), "account-model");
});

test("OpenAI stream adapter maps Responses API deltas and usage", async () => {
  const usageBefore = { input: openaiUsage.input, output: openaiUsage.output, calls: openaiUsage.calls };
  let request;
  const api = { responses: { create: async (body) => {
    request = body;
    return (async function* () {
      yield { type: "response.output_text.delta", delta: "hello " };
      yield { type: "response.output_text.delta", delta: "council" };
      yield { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 3 } } };
    })();
  } } };
  const provider = createOpenAIProvider(api);
  const chunks = [];
  const result = await provider.stream({ model: "gpt-test", system: "Be a chair", messages: [{ role: "user", content: "Decide" }], onText: (x) => chunks.push(x) });
  assert.equal(result, "hello council");
  assert.deepEqual(chunks, ["hello ", "council"]);
  assert.equal(request.model, "gpt-test");
  assert.equal(request.instructions, "Be a chair");
  assert.equal(request.input[0].content, "Decide");
  assert.equal(request.stream, true);
  assert.equal(openaiUsage.input - usageBefore.input, 12);
  assert.equal(openaiUsage.output - usageBefore.output, 3);
  assert.equal(openaiUsage.calls - usageBefore.calls, 1);
});

test("OpenAI structured output uses strict Responses API JSON schema", async () => {
  const usageBefore = { input: openaiUsage.input, output: openaiUsage.output };
  let request;
  const api = { responses: { create: async (body) => {
    request = body;
    return { status: "completed", output_text: '{"call":"go"}', usage: { input_tokens: 7, output_tokens: 2 } };
  } } };
  const provider = createOpenAIProvider(api);
  const result = await provider.json({ model: "gpt-test", system: "Chair", prompt: "Write", schema: { type: "object", properties: { call: { type: "string" } }, required: ["call"], additionalProperties: false } });
  assert.deepEqual(result, { call: "go" });
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.properties.call.type, "string");
  assert.equal(openaiUsage.input - usageBefore.input, 7);
  assert.equal(openaiUsage.output - usageBefore.output, 2);
});

test("OpenAI adapter reports empty content and maps auth errors without exposing details", async () => {
  const empty = createOpenAIProvider({ responses: { create: async () => ({ status: "completed", output_text: "  " }) } });
  await assert.rejects(() => empty.json({ model: "gpt-test", system: "", prompt: "", schema: {} }), /empty structured response/);
  const denied = createOpenAIProvider({ responses: { create: async () => { throw Object.assign(new Error("secret-key should not appear"), { status: 401 }); } } });
  await assert.rejects(() => denied.json({ model: "gpt-test", system: "", prompt: "", schema: {} }), (err) => {
    assert.match(err.message, /Check OPENAI_API_KEY/);
    assert.doesNotMatch(err.message, /secret-key/);
    return true;
  });
});

test("Anthropic streaming API path retains Messages request format without a network call", async () => {
  const oldKey = process.env.ANTHROPIC_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    const lines = [
      { type: "message_start", message: { usage: { input_tokens: 9 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "kept " } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "working" } },
      { type: "message_delta", usage: { output_tokens: 2 } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    return { ok: true, body: (async function* () { yield Buffer.from(lines); })() };
  };
  try {
    const deltas = [];
    const result = await anthropic.stream({
      model: "claude-test", system: [{ type: "text", text: "seat persona", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "question" }], onText: (text) => deltas.push(text),
    });
    assert.equal(result, "kept working");
    assert.deepEqual(deltas, ["kept ", "working"]);
    assert.equal(request.url, "https://api.anthropic.com/v1/messages");
    assert.equal(request.options.headers["x-api-key"], "test-anthropic-key");
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, "claude-test");
    assert.equal(body.system[0].cache_control.type, "ephemeral");
    assert.equal(body.stream, true);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldKey;
  }
});
