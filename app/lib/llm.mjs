import { llmProvider } from "./env.mjs";
import * as anthropic from "./anthropic.mjs";
import * as openai from "./openai.mjs";

export const provider = llmProvider();
export const selectProvider = (name, implementations = { anthropic, openai }) => implementations[name];
const selected = selectProvider(provider);
export const stream = selected.stream;
export const json = selected.json;
export const usage = selected.usage;
