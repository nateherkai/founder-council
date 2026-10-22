import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Two layouts: nested two folders deep in a larger workspace, or the standalone
// student repo (app/ beside .claude/). The kit has .claude one level up.
const KIT = fs.existsSync(path.join(APP_ROOT, "..", ".claude", "skills", "roast-room"));
export const REPO_ROOT = KIT ? path.resolve(APP_ROOT, "..") : path.resolve(APP_ROOT, "..", "..");
export const BRAINS_DIR = path.join(REPO_ROOT, ".claude", "skills", "roast-room", "brains");
export const ROSTER = path.join(REPO_ROOT, ".claude", "skills", "roast-room", "roster.json");
export const AGENTS_DIR = path.join(REPO_ROOT, ".claude", "agents");
export const SESSIONS_DIR = KIT ? path.join(REPO_ROOT, "sessions") : path.join(REPO_ROOT, "projects", "founder-council", "sessions");

let cache = null;
export function env(key) {
  if (process.env[key]) return process.env[key];
  if (!cache) {
    cache = {};
    const p = path.join(REPO_ROOT, ".env");
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !(m[1] in cache)) cache[m[1]] = m[2].trim();
      }
    }
  }
  return cache[key] || "";
}

export function llmProvider() {
  return normalizeLlmProvider(env("LLM_PROVIDER"));
}

export function normalizeLlmProvider(value = "") {
  const provider = (value || "anthropic").trim().toLowerCase();
  if (provider !== "anthropic" && provider !== "openai") {
    throw new Error(`Unsupported LLM_PROVIDER "${provider}". Set LLM_PROVIDER=anthropic or LLM_PROVIDER=openai in .env.`);
  }
  return provider;
}

export function validateLlmConfig(provider = llmProvider(), readEnv = env) {
  const keyName = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  if (!readEnv(keyName).trim()) throw new Error(`Missing ${keyName}. Add it to .env to use the ${provider} API runner.`);
}

export function llmModel(role, provider = llmProvider(), readEnv = env) {
  const model = readEnv(provider === "openai" ? "OPENAI_MODEL" : "ANTHROPIC_MODEL");
  if (model.trim()) return model.trim();
  // Preserve existing role-specific Anthropic overrides while honoring the
  // new single model setting by default.
  if (provider === "anthropic") {
    const legacy = readEnv(role === "seat" ? "SEAT_MODEL" : "CHAIR_MODEL");
    if (legacy.trim()) return legacy.trim();
    return "claude-sonnet-5";
  }
  return "gpt-5.1";
}
