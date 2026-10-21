// scripts/hybrid-fault-injection-smoke.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "hybrid", "runner.mjs");
const PREFIX = `__fault-injection-${process.pid}`;
const SECRET = `SECRET_SENTINEL_${process.pid}`;
const created = [];

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

const cruxes = {
  cruxes: [{
    question: "Which option gives the fastest reliable learning?",
    sides: [
      { position: "Choose A", seats: ["graham"] },
      { position: "Protect downside", seats: [] },
    ],
  }],
  unanimous: false,
  note: "Synthetic fault-injection crux.",
  pressure: [],
};

const verdict = {
  label: "GO",
  call: "Choose A and measure the result.",
  override_note: "",
  recommended: "A",
  why: [
    { point: "Fast feedback", seat: "graham", framework: "learning" },
    { point: "Reversible", seat: "graham", framework: "optionality" },
    { point: "Cheap", seat: "graham", framework: "downside" },
  ],
  fights: [],
  minority: { seat: "graham", quote: "Choose A.", would_have_to_be_true: "The signal is useful." },
  amendments: [],
  conditions: ["Measure the result."],
  next_steps: [{ when: "This week", action: "Run the test." }],
  cheapest_test: "One small experiment.",
  kill_criteria: "No useful signal.",
  revisit: "After the experiment.",
};

function sessionDir(id) { return path.join(ROOT, "sessions", id); }
function track(p) { created.push(p); return p; }
function writeJson(p, value) { fs.writeFileSync(p, JSON.stringify(value, null, 2)); }

function createCouncil(id) {
  const dir = track(sessionDir(id));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "council.json"), {
    title: "Fault injection",
    decision: "A or B?",
    mode: "quick",
    runner: "hybrid",
    options: [{ id: "A", label: "A" }, { id: "B", label: "B" }],
    weights: { graham: { weight: 3, reason: "market feedback" } },
    seats: ["graham"],
    brief: `Synthetic deterministic fixture ${SECRET}`,
    assumptions: [],
  });
  return dir;
}

function writeRound(dir, round) {
  fs.writeFileSync(path.join(dir, `round-${round}.md`), `# Round ${round}\n\n## Paul Graham (weight 3)\n\n${card}`, "utf8");
}

function readMeta(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "hybrid-meta.json"), "utf8"));
}

function latestCalls(dir) {
  return readMeta(dir).latest_run?.provider_calls || [];
}

function assertTelemetryShape(dir) {
  const metaText = fs.readFileSync(path.join(dir, "hybrid-meta.json"), "utf8");
  assert.equal(metaText.includes(SECRET), false, "telemetry leaked council prompt/brief content");
  assert.equal(metaText.includes("THE CALL: Choose A"), false, "telemetry leaked model output");
  for (const call of latestCalls(dir)) {
    assert.equal(typeof call.provider, "string");
    assert.equal(typeof call.phase, "string");
    assert.ok(Number.isInteger(call.attempt) && call.attempt >= 1);
    assert.ok(Number.isFinite(call.duration_ms) && call.duration_ms >= 0);
    assert.equal(typeof call.fallback, "boolean");
    if (!call.ok) assert.equal(typeof call.error_type, "string");
  }
}

function makeGenericStub(name) {
  const p = track(path.join(ROOT, `.${PREFIX}-${name}.mjs`));
  fs.writeFileSync(p, `import fs from "node:fs";
const mode = process.env.STUB_MODE || "process_exit";
const counter = process.env.STUB_COUNTER || "";
let n = 0;
if (counter) {
  n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(n + 1));
}
const card = ${JSON.stringify(card)};
const cruxes = ${JSON.stringify(JSON.stringify(cruxes))};
const verdict = ${JSON.stringify(JSON.stringify(verdict))};
if (mode === "rate_limit") {
  if (n === 0) { console.error("HTTP 429 rate limit"); process.exit(7); }
  if (n === 1) { process.stdout.write(card); process.exit(0); }
  console.error("EXPECTED_CHAIR_STOP"); process.exit(7);
}
if (mode === "network") {
  if (n === 0) { console.error("ECONNRESET network reset"); process.exit(7); }
  if (n === 1) { process.stdout.write(card); process.exit(0); }
  console.error("EXPECTED_CHAIR_STOP"); process.exit(7);
}
if (mode === "timeout") { setInterval(() => {}, 1000); }
if (mode === "invalid_score") { process.stdout.write("SEAT: GRAHAM\\nSTANCE: Yes\\nMALFORMED_CARD_SECRET\\n"); process.exit(0); }
if (mode === "invalid_json") { process.stdout.write("not-json-at-all"); process.exit(0); }
if (mode === "crux_then_fail") {
  if (n === 0) { process.stdout.write(cruxes); process.exit(0); }
  console.error("EXPECTED_AFTER_CRUX_STOP"); process.exit(7);
}
if (mode === "valid_verdict") { process.stdout.write(verdict); process.exit(0); }
console.error("provider exited unexpectedly"); process.exit(7);
`, "utf8");
  return p;
}

function makeCopilotExitStub() {
  const p = track(path.join(ROOT, `.${PREFIX}-copilot-exit.mjs`));
  fs.writeFileSync(p, `console.error("copilot synthetic process exit"); process.exit(9);\n`, "utf8");
  return p;
}

function run(id, env = {}, timeout = 12_000) {
  return spawnSync(process.execPath, [RUNNER, "--resume", id], {
    cwd: ROOT,
    env: {
      ...process.env,
      GEMINI_CONCURRENCY: "1",
      GEMINI_SEAT_RETRIES: "1",
      GEMINI_RETRY_BASE_MS: "250",
      ...env,
    },
    encoding: "utf8",
    timeout,
  });
}

function expectFailed(result, label) {
  if (result.error) throw result.error;
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
}

function seatFault(name, mode, expectedType, retryExpected) {
  const id = `${PREFIX}-${name}`;
  const dir = createCouncil(id);
  const stub = makeGenericStub(name);
  const counter = track(path.join(ROOT, `.${PREFIX}-${name}.count`));
  fs.rmSync(counter, { force: true });
  const result = run(id, {
    CHAIR_PROVIDER: "gemini",
    GEMINI_CLI_ENTRY: stub,
    STUB_MODE: mode,
    STUB_COUNTER: counter,
    ...(mode === "timeout" ? { GEMINI_TIMEOUT_MS: "100" } : {}),
  });
  expectFailed(result, name);
  const calls = latestCalls(dir).filter((c) => c.role === "seat");
  if (retryExpected) {
    assert.equal(calls.length, 2, `${name} should have exactly two seat attempts`);
    assert.equal(calls[0].error_type, expectedType);
    assert.equal(calls[0].retry_scheduled, true);
    assert.equal(calls[0].attempt, 1);
    assert.equal(calls[1].ok, true);
    assert.equal(calls[1].attempt, 2);
  } else {
    assert.equal(calls.length, 1, `${name} must not retry`);
    assert.equal(calls[0].error_type, expectedType);
    assert.equal(Boolean(calls[0].retry_scheduled), false);
    assert.equal(calls[0].attempt, 1);
  }
  assertTelemetryShape(dir);
}

try {
  // Current policy: only rate_limit and network retry; timeout/invalid output/process exit do not.
  seatFault("rate-limit", "rate_limit", "rate_limit", true);
  seatFault("network-reset", "network", "network", true);
  seatFault("timeout", "timeout", "timeout", false);
  seatFault("invalid-score", "invalid_score", "invalid_output", false);
  seatFault("gemini-exit", "process_exit", "process_exit", false);

  // Malformed Chair JSON is classified and never retried when Gemini is the requested Chair.
  {
    const id = `${PREFIX}-malformed-json`;
    const dir = createCouncil(id);
    writeRound(dir, 1);
    const stub = makeGenericStub("malformed-json");
    const result = run(id, { CHAIR_PROVIDER: "gemini", GEMINI_CLI_ENTRY: stub, STUB_MODE: "invalid_json" });
    expectFailed(result, "malformed-json");
    const calls = latestCalls(dir);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].role, "chair");
    assert.equal(calls[0].phase, "cruxes");
    assert.equal(calls[0].error_type, "invalid_output");
    assertTelemetryShape(dir);
  }

  // Copilot Chair process exit must fall back once to Gemini, with explicit fallback telemetry.
  {
    const id = `${PREFIX}-copilot-fallback`;
    const dir = createCouncil(id);
    writeRound(dir, 1);
    const gemini = makeGenericStub("copilot-fallback-gemini");
    const copilot = makeCopilotExitStub();
    const counter = track(path.join(ROOT, `.${PREFIX}-copilot-fallback.count`));
    fs.rmSync(counter, { force: true });
    const result = run(id, {
      CHAIR_PROVIDER: "copilot",
      COPILOT_CLI_ENTRY: copilot,
      GEMINI_CLI_ENTRY: gemini,
      STUB_MODE: "crux_then_fail",
      STUB_COUNTER: counter,
    });
    expectFailed(result, "copilot-fallback");
    const chair = latestCalls(dir).filter((c) => c.role === "chair" && c.phase === "cruxes");
    assert.equal(chair.length, 2);
    assert.equal(chair[0].provider, "github-copilot-student");
    assert.equal(chair[0].error_type, "process_exit");
    assert.equal(chair[0].fallback, false);
    assert.equal(chair[1].provider, "gemini-cli");
    assert.equal(chair[1].ok, true);
    assert.equal(chair[1].fallback, true);
    assertTelemetryShape(dir);
  }

  // Fail after Cruxes/round checkpoints but before Verdict, then resume without rerunning seats.
  {
    const id = `${PREFIX}-before-verdict`;
    const dir = createCouncil(id);
    writeRound(dir, 1);
    writeJson(path.join(dir, "cruxes.json"), cruxes);
    writeRound(dir, 2);
    const failStub = makeGenericStub("before-verdict-fail");
    const first = run(id, { CHAIR_PROVIDER: "gemini", GEMINI_CLI_ENTRY: failStub, STUB_MODE: "process_exit" });
    expectFailed(first, "before-verdict first run");
    assert.equal(first.stdout.includes("Gemini 1.Graham"), false);
    assert.equal(first.stdout.includes("Gemini 2.Graham"), false);
    let calls = latestCalls(dir);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].role, "chair");
    assert.equal(calls[0].phase, "verdict");
    assert.equal(calls[0].error_type, "process_exit");

    const okStub = makeGenericStub("before-verdict-ok");
    const second = run(id, { CHAIR_PROVIDER: "gemini", GEMINI_CLI_ENTRY: okStub, STUB_MODE: "valid_verdict" });
    if (second.error) throw second.error;
    assert.equal(second.status, 0, `resume after verdict failure failed: ${second.stderr}`);
    assert.equal(second.stdout.includes("Gemini 1.Graham"), false);
    assert.equal(second.stdout.includes("Gemini 2.Graham"), false);
    assert.ok(fs.existsSync(path.join(dir, "verdict.json")));
    calls = latestCalls(dir);
    assert.equal(calls.some((c) => c.role === "seat"), false, "completed seats reran during verdict resume");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].phase, "verdict");
    assert.equal(calls[0].ok, true);
    assertTelemetryShape(dir);
  }

  console.log("Hybrid fault injection smoke OK: deterministic failure matrix, resume invariants, fallback, and telemetry all pass");
} finally {
  for (const p of created.reverse()) fs.rmSync(p, { recursive: true, force: true });
}
