import { env } from "./env.mjs";
export { S } from "./schema.mjs";

const URL = "https://api.anthropic.com/v1/messages";
const RETRY = new Set([429, 500, 502, 503, 529]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers() {
  return {
    "x-api-key": env("ANTHROPIC_API_KEY"),
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
}

// Running token tally for the whole app, shown in the UI.
export const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
function addUsage(u = {}) {
  usage.input += u.input_tokens || 0;
  usage.output += u.output_tokens || 0;
  usage.cacheRead += u.cache_read_input_tokens || 0;
  usage.cacheWrite += u.cache_creation_input_tokens || 0;
  usage.calls += 1;
}

/** Stream a message; calls onText(delta) as text arrives. Returns the full text. */
export async function stream({ model, system, messages, maxTokens = 2000, onText = () => {} }) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model, system, messages, max_tokens: maxTokens, stream: true }),
    });
    if (RETRY.has(res.status)) { await sleep(Math.min(30000, 2000 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    let text = "";
    let buf = "";
    const dec = new TextDecoder();
    const finalUsage = {};
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          text += ev.delta.text;
          onText(ev.delta.text);
        } else if (ev.type === "message_start") {
          Object.assign(finalUsage, ev.message?.usage || {});
        } else if (ev.type === "message_delta") {
          Object.assign(finalUsage, ev.usage || {});
        } else if (ev.type === "error") {
          throw new Error(`Anthropic stream error: ${JSON.stringify(ev.error).slice(0, 300)}`);
        }
      }
    }
    addUsage(finalUsage);
    return text;
  }
  throw new Error("Anthropic API kept refusing after retries");
}
/** One call with structured JSON output matching `schema`. */
export async function json({ model, system, prompt, schema, maxTokens = 4000 }) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model, system, max_tokens: maxTokens,
        output_config: { format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (RETRY.has(res.status)) { await sleep(Math.min(30000, 2000 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    addUsage(j.usage);
    if (j.stop_reason === "max_tokens") throw new Error("Chair output hit max_tokens");
    return JSON.parse(j.content.map((b) => b.text || "").join(""));
  }
  throw new Error("Anthropic API kept refusing after retries");
}
