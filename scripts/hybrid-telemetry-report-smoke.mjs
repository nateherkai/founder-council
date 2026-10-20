// scripts/hybrid-telemetry-report-smoke.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTelemetryReport } from "./hybrid-telemetry-report.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roast-room-telemetry-report-"));
const sessionDir = path.join(root, "telemetry-fixture-1");
fs.mkdirSync(sessionDir, { recursive: true });

const meta = {
  created: "2026-10-21T00:00:00.000Z",
  prompt: "SECRET_PROMPT_SENTINEL",
  output: "SECRET_OUTPUT_SENTINEL",
  secret: "SECRET_VALUE_SENTINEL",
  runs: [{
    id: "run-fixture",
    started_at: "2026-10-21T00:00:00.000Z",
    completed_at: "2026-10-21T00:00:10.000Z",
    duration_ms: 10000,
    prompt: "SECRET_PROMPT_SENTINEL_2",
    provider_calls: [
      {
        at: "2026-10-21T00:00:01.000Z",
        role: "chair",
        task: "setup",
        phase: "setup",
        provider: "github-copilot-student",
        ok: true,
        duration_ms: 1000,
        output: "SECRET_OUTPUT_SENTINEL_2"
      },
      {
        at: "2026-10-21T00:00:04.000Z",
        role: "seat",
        task: "round-1",
        phase: "round-1",
        seat: "graham",
        provider: "gemini-cli",
        ok: false,
        duration_ms: 2000,
        attempt: 1,
        retry_scheduled: true,
        error_type: "rate_limit",
        error_message: "SECRET_ERROR_SENTINEL"
      },
      {
        at: "2026-10-21T00:00:07.000Z",
        role: "seat",
        task: "round-1",
        phase: "round-1",
        seat: "graham",
        provider: "gemini-cli",
        ok: true,
        duration_ms: 3000,
        attempt: 2
      },
      {
        at: "2026-10-21T00:00:09.000Z",
        role: "chair",
        task: "verdict",
        phase: "verdict",
        provider: "gemini-cli",
        ok: true,
        fallback: true,
        duration_ms: 1200
      }
    ]
  }]
};

fs.writeFileSync(path.join(sessionDir, "hybrid-meta.json"), JSON.stringify(meta, null, 2));
// This file must never be opened by the reporting tool.
fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify({ output: "FORBIDDEN_VERDICT_SENTINEL" }));

try {
  const report = buildTelemetryReport(root, { prefix: "telemetry-fixture-" });
  assert.equal(report.totals.sessions, 1);
  assert.equal(report.totals.runs, 1);
  assert.equal(report.totals.completed_runs, 1);
  assert.equal(report.totals.provider_calls, 4);
  assert.equal(report.totals.failures, 1);
  assert.equal(report.totals.retries_scheduled, 1);
  assert.equal(report.totals.fallbacks, 1);
  assert.equal(report.totals.failure_rate, 0.25);
  assert.equal(report.totals.retry_rate, 0.25);
  assert.equal(report.totals.retry_rate_among_failures, 1);
  assert.equal(report.totals.fallback_rate, 0.25);
  assert.equal(report.by_error_type[0].error_type, "rate_limit");
  assert.equal(report.by_error_type[0].contexts[0].provider, "gemini-cli");
  assert.equal(report.by_error_type[0].contexts[0].phase, "round-1");
  assert.equal(report.runs[0].phases["round-1"].calls, 2);
  assert.equal(report.runs[0].phases["round-1"].observed_provider_span_ms, 5000);
  assert.equal(report.runs[0].chair.provider_duration_sum_ms, 2200);
  assert.equal(report.data_quality.exact_phase_wall_clock_available, false);

  const serialized = JSON.stringify(report);
  for (const forbidden of [
    "SECRET_PROMPT_SENTINEL",
    "SECRET_OUTPUT_SENTINEL",
    "SECRET_VALUE_SENTINEL",
    "SECRET_ERROR_SENTINEL",
    "FORBIDDEN_VERDICT_SENTINEL",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `report leaked ${forbidden}`);
  }
  assert.equal(/\"prompt\"\s*:/.test(serialized), false);
  assert.equal(/\"output\"\s*:/.test(serialized), false);
  assert.equal(/\"error_message\"\s*:/.test(serialized), false);
  assert.equal(/\"secret\"\s*:/.test(serialized), false);

  console.log("Hybrid telemetry reporting smoke OK: aggregates operational metadata without prompt/output/secret leakage");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
