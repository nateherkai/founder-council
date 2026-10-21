// scripts/hybrid-telemetry-smoke.mjs
import assert from "node:assert/strict";
import { classifyProviderError, createSessionTelemetry } from "../hybrid/telemetry.mjs";

let now = Date.parse("2026-10-20T21:00:00.000Z");
const writes = [];
const telemetry = createSessionTelemetry({
  resumed: true,
  pid: 4242,
  now: () => now,
});

// Verify pre-attachment provider activity survives until the session path exists.
now += 120;
telemetry.provider({
  role: "chair",
  task: "setup",
  provider: "github-copilot-student",
  ok: false,
  duration_ms: 120,
  error_type: "process_exit",
});
now += 80;
telemetry.provider({
  role: "chair",
  task: "setup",
  provider: "gemini-cli",
  ok: true,
  fallback: true,
  duration_ms: 80,
});

telemetry.attach(
  { created: "2026-10-20T20:00:00.000Z", runs: [{ id: "older-run", provider_calls: [] }] },
  (doc) => writes.push(structuredClone(doc)),
);

now += 500;
telemetry.provider({
  role: "seat",
  task: "round-1",
  seat: "graham",
  provider: "gemini-cli",
  ok: true,
  attempt: 2,
  duration_ms: 500,
});

now += 30;
telemetry.complete({ chair_providers_used: ["gemini-cli-fallback"] });

const doc = telemetry.snapshot();
assert.equal(doc.runs.length, 2);
assert.equal(doc.latest_run.id, telemetry.run.id);
assert.equal(doc.latest_run.resumed, true);
assert.equal(doc.latest_run.provider_calls.length, 3);
assert.equal(doc.latest_run.provider_calls[0].phase, "setup");
assert.equal(doc.latest_run.provider_calls[0].attempt, 1);
assert.equal(doc.latest_run.provider_calls[0].fallback, false);
assert.equal(doc.latest_run.provider_calls[1].fallback, true);
assert.equal(doc.latest_run.provider_calls[2].seat, "graham");
assert.equal(doc.latest_run.provider_calls[2].phase, "round-1");
assert.equal(doc.latest_run.provider_calls[2].attempt, 2);
assert.equal(doc.latest_run.completed_at, "2026-10-20T21:00:00.730Z");
assert.equal(doc.latest_run.duration_ms, 730);
assert.ok(writes.length >= 3);

assert.equal(classifyProviderError(new Error("Timed out: gemini.js")), "timeout");
assert.equal(classifyProviderError(new Error("HTTP 429 rate limit")), "rate_limit");
assert.equal(classifyProviderError(new Error("ECONNRESET network failure")), "network");
assert.equal(classifyProviderError(new Error("Chair returned no JSON object")), "invalid_output");
assert.equal(classifyProviderError(new Error("copilot.exe exited 7")), "process_exit");
assert.equal(classifyProviderError(new Error("unknown failure")), "provider_error");

console.log("Hybrid telemetry smoke OK: buffered calls, fallback metadata, timing, and error classification pass");
