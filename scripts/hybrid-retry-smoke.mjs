// scripts/hybrid-retry-smoke.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { retryDelayMs, shouldRetryProviderError } from "../hybrid/retry.mjs";

assert.equal(shouldRetryProviderError("rate_limit"), true);
assert.equal(shouldRetryProviderError("network"), true);
assert.equal(shouldRetryProviderError("timeout"), false);
assert.equal(shouldRetryProviderError("invalid_output"), false);
assert.equal(shouldRetryProviderError("auth"), false);
assert.equal(shouldRetryProviderError("process_exit"), false);
assert.equal(retryDelayMs(1, 1500, 10000), 1500);
assert.equal(retryDelayMs(2, 1500, 10000), 3000);
assert.equal(retryDelayMs(3, 1500, 10000), 6000);
assert.equal(retryDelayMs(4, 1500, 10000), 10000);
assert.equal(retryDelayMs(20, 1500, 10000), 10000);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const id = `__retry-smoke-${process.pid}`;
const dir = path.join(ROOT, "sessions", id);
const dummy = path.join(ROOT, `.retry-smoke-gemini-${process.pid}.mjs`);
const counter = path.join(ROOT, `.retry-smoke-count-${process.pid}.txt`);
const runner = path.join(ROOT, "hybrid", "runner.mjs");

const card = `SEAT: GRAHAM (Product & startups)
STANCE: Yes
OPTION SCORES: A 8/10 · B 3/10
PILLAR SCORE: 8/10
CONFIDENCE: 4/5
RUIN RISK: none
DOOR: two-way

THE CALL: Choose A.
WHY:
1. Fast feedback.
2. Reversible.
3. Cheap.
THE RISK I SEE: Weak signal.
WHAT WOULD CHANGE MY MIND: No response.
WHAT I'D DO THIS WEEK: Test A.
QUESTION FOR THE FOUNDER: What happened?
`;

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(dummy, { force: true });
fs.rmSync(counter, { force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "council.json"), JSON.stringify({
  title: "Retry smoke",
  decision: "A or B?",
  mode: "quick",
  runner: "hybrid",
  options: [{ id: "A", label: "A" }, { id: "B", label: "B" }],
  weights: { graham: { weight: 3, reason: "market feedback" } },
  seats: ["graham"],
  brief: "Synthetic retry fixture.",
  assumptions: [],
}, null, 2));

try {
  // Keep the fixture deterministic: first seat call rate-limits, retry succeeds, then Chair fails fast.
  fs.writeFileSync(dummy, `// generated retry Gemini stub
import fs from "node:fs";
const counter = ${JSON.stringify(counter)};
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(n + 1));
if (n === 0) {
  console.error("HTTP 429 rate limit");
  process.exit(7);
}
if (n === 1) {
  process.stdout.write(${JSON.stringify(card)});
  process.exit(0);
}
console.error("EXPECTED_RETRY_SMOKE_CHAIR_STOP");
process.exit(7);
`, "utf8");

  const result = spawnSync(process.execPath, [runner, "--resume", id], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHAIR_PROVIDER: "gemini",
      GEMINI_CLI_ENTRY: dummy,
      GEMINI_CONCURRENCY: "1",
      GEMINI_SEAT_RETRIES: "1",
      GEMINI_RETRY_BASE_MS: "250",
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status === 0) throw new Error("retry smoke unexpectedly completed the whole council");
  if (!result.stderr.includes("hit rate_limit; retrying in 250ms")) {
    throw new Error(`runner did not announce transient retry: ${result.stderr}`);
  }

  const round = JSON.parse(fs.readFileSync(path.join(dir, "round-1.json"), "utf8"));
  assert.ok(round.cards?.graham, "seat retry did not produce a checkpoint");

  const meta = JSON.parse(fs.readFileSync(path.join(dir, "hybrid-meta.json"), "utf8"));
  const calls = meta.latest_run?.provider_calls || [];
  const seatCalls = calls.filter((call) => call.role === "seat" && call.seat === "graham");
  assert.equal(seatCalls.length, 2);
  assert.equal(seatCalls[0].ok, false);
  assert.equal(seatCalls[0].error_type, "rate_limit");
  assert.equal(seatCalls[0].retry_scheduled, true);
  assert.equal(seatCalls[0].attempt, 1);
  assert.equal(seatCalls[1].ok, true);
  assert.equal(seatCalls[1].attempt, 2);

  console.log("Hybrid retry smoke OK: transient 429 retried once, checkpointed, and recorded both attempts");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dummy, { force: true });
  fs.rmSync(counter, { force: true });
}
