// scripts/hybrid-crash-resume-smoke.mjs
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const id = `__crash-resume-smoke-${process.pid}`;
const dir = path.join(ROOT, "sessions", id);
const dummy = path.join(ROOT, `.crash-resume-smoke-gemini-${process.pid}.mjs`);
const counter = path.join(ROOT, `.crash-resume-smoke-count-${process.pid}.txt`);
const runner = path.join(ROOT, "hybrid", "runner.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Exercise the same process-tree semantics used by the Hybrid server Stop control.
async function killTree(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch {}
    }
  }
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    sleep(2_000),
  ]);
}

function savedCards() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "round-1.json"), "utf8")).cards || {};
  } catch {
    return {};
  }
}

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(dummy, { force: true });
fs.rmSync(counter, { force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "council.json"), JSON.stringify({
  title: "Crash resume smoke",
  decision: "A or B?",
  mode: "quick",
  runner: "hybrid",
  options: [{ id: "A", label: "A" }, { id: "B", label: "B" }],
  weights: {
    graham: { weight: 3, reason: "market feedback" },
    buffett: { weight: 2, reason: "downside check" },
  },
  seats: ["graham", "buffett"],
  brief: "Synthetic crash/recovery fixture.",
  assumptions: [],
}, null, 2));

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

try {
  fs.writeFileSync(dummy, `// generated crash-resume Gemini stub
import fs from "node:fs";
const counter = ${JSON.stringify(counter)};
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(n + 1));
if (n === 0) {
  process.stdout.write(${JSON.stringify(card)});
  process.exit(0);
}
setInterval(() => {}, 1000);
`, "utf8");

  const first = spawn(process.execPath, [runner, "--resume", id], {
    cwd: ROOT,
    env: { ...process.env, GEMINI_CLI_ENTRY: dummy, GEMINI_CONCURRENCY: "1", GEMINI_SEAT_RETRIES: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let firstOut = "";
  first.stdout.on("data", (chunk) => (firstOut += chunk));

  let checkpointed = false;
  for (let i = 0; i < 80; i += 1) {
    const invocations = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
    if (savedCards().graham && invocations >= 2) {
      checkpointed = true;
      break;
    }
    await sleep(100);
  }
  if (!checkpointed) throw new Error(`runner never reached crash point: ${firstOut}`);
  await killTree(first);

  const afterCrash = savedCards();
  if (!afterCrash.graham || afterCrash.buffett) throw new Error(`bad checkpoint after crash: ${JSON.stringify(afterCrash)}`);

  fs.writeFileSync(dummy, `// generated fail-fast Gemini stub
console.error("EXPECTED_CRASH_RESUME_FAILURE");
process.exit(7);
`, "utf8");
  const second = spawnSync(process.execPath, [runner, "--resume", id], {
    cwd: ROOT,
    env: { ...process.env, GEMINI_CLI_ENTRY: dummy, GEMINI_CONCURRENCY: "1", GEMINI_SEAT_RETRIES: "0" },
    encoding: "utf8",
    timeout: 10_000,
  });
  if (second.status === 0) throw new Error("second resume unexpectedly completed");
  if (!second.stdout.includes("Gemini 1.Buffett")) throw new Error(`missing seat was not scheduled: ${second.stdout}`);
  if (second.stdout.includes("Gemini 1.Graham")) throw new Error(`saved seat was rerun: ${second.stdout}`);
  if (!savedCards().graham || savedCards().buffett) throw new Error("checkpoint changed after failed resume");

  console.log("Hybrid crash/resume smoke OK: persisted seat survived process death and was not rerun");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dummy, { force: true });
  fs.rmSync(counter, { force: true });
}
