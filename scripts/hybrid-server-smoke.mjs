import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const sessions = path.join(repo, "sessions");
const id = "__hybrid-server-smoke";
const dir = path.join(sessions, id);
const dummy = path.join(repo, ".hybrid-server-smoke-gemini.mjs");
const port = 4733;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(dummy, "setInterval(() => {}, 1000);\n");
fs.writeFileSync(path.join(dir, "council.json"), JSON.stringify({
  title: "Hybrid server smoke", decision: "Test progress and stop guards", mode: "quick",
  options: [{ id: "A", label: "A" }, { id: "B", label: "B" }],
  weights: {
    graham: { weight: 3, reason: "smoke" }, garyvee: { weight: 2, reason: "smoke" },
    buffett: { weight: 2, reason: "smoke" }, bezos: { weight: 3, reason: "smoke" }
  },
  seats: ["graham", "garyvee", "buffett", "bezos"], brief: "Smoke test", assumptions: [], runner: "hybrid"
}, null, 2));
fs.writeFileSync(path.join(dir, "round-1.json"), JSON.stringify({
  round: 1, cards: { graham: { text: "saved" }, garyvee: { text: "saved" } }, scores: {}
}, null, 2));
fs.writeFileSync(path.join(dir, "hybrid-meta.json"), JSON.stringify({
  created: new Date().toISOString(),
  latest_run: {
    id: "smoke-run",
    started_at: new Date(Date.now() - 1500).toISOString(),
    duration_ms: 1500,
    provider_calls: [
      { role: "chair", task: "cruxes", provider: "github-copilot-student", ok: false, duration_ms: 700, error_type: "process_exit" },
      { role: "chair", task: "cruxes", provider: "gemini-cli", ok: true, fallback: true, duration_ms: 800 },
    ],
  },
}, null, 2));

const child = spawn(process.execPath, ["app/server.mjs"], {
  cwd: repo,
  env: { ...process.env, PORT: String(port), COUNCIL_RUNNER: "hybrid", GEMINI_CLI_ENTRY: dummy },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${base}/api/seats`); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`server did not become ready: ${stderr}`);
}
const sessionsApi = () => fetch(`${base}/api/sessions`).then((r) => r.json());
const findSmoke = async () => (await sessionsApi()).sessions.find((x) => x.id === id);

try {
  await waitForServer();
  let s = await findSmoke();
  if (
    !s?.resumable ||
    s.stoppable ||
    s.progress?.label !== "Openings 2/4" ||
    s.metrics?.provider_calls !== 2 ||
    s.metrics?.failed_calls !== 1 ||
    s.metrics?.fallbacks !== 1 ||
    s.metrics?.duration_ms < 1500
  ) throw new Error(`bad inactive state: ${JSON.stringify(s)}`);

  const resume = await fetch(`${base}/api/sessions/${id}/resume`, { method: "POST" });
  if (!resume.ok) throw new Error(`resume failed: ${resume.status} ${await resume.text()}`);
  await sleep(500);
  s = await findSmoke();
  if (!s?.stoppable || s.resumable || s.progress?.label !== "Openings 2/4") throw new Error(`bad running state: ${JSON.stringify(s)}`);

  const stop = await fetch(`${base}/api/sessions/${id}/stop`, { method: "POST" });
  const stopped = await stop.json();
  if (!stop.ok || stopped.status !== "stopped" || !stopped.resumable) throw new Error(`stop failed: ${stop.status} ${JSON.stringify(stopped)}`);
  await sleep(250);
  s = await findSmoke();
  if (!s?.resumable || s.stoppable || s.failure) throw new Error(`bad stopped state: ${JSON.stringify(s)}`);

  // Model a torn verdict so the session must stay resumable.
  fs.writeFileSync(path.join(dir, "verdict.json"), '{"label":"GO"');
  s = await findSmoke();
  if (!s?.resumable || s.progress?.label === "Complete") {
    throw new Error(`corrupt verdict blocked resume: ${JSON.stringify(s)}`);
  }

  fs.writeFileSync(dummy, "console.error('SMOKE_FAILURE'); process.exit(7);\n");
  await fetch(`${base}/api/sessions/${id}/resume`, { method: "POST" });
  await sleep(800);
  s = await findSmoke();
  if (!s?.resumable || s.stoppable || !s.failure?.message) throw new Error(`failure was not persisted: ${JSON.stringify(s)}`);
  console.log("Hybrid server smoke OK: progress, stop, corrupt-verdict recovery, metrics, resumability, and persisted failure all pass");
} finally {
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dummy, { force: true });
}
