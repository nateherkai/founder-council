import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { APP_ROOT, REPO_ROOT, SESSIONS_DIR, env } from "./lib/env.mjs";
import { SEATS } from "./lib/seats.mjs";
import { startCouncil, getSession, subscribe, listSaved, loadSaved, MODELS } from "./lib/council.mjs";
import { usage } from "./lib/anthropic.mjs";
import * as watch from "./lib/watch.mjs";

const PORT = Number(process.env.PORT) || 4730;
const PUBLIC = path.join(APP_ROOT, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8" };

// Keep session inspection tolerant of interrupted or legacy checkpoint files.
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Keep server-owned failure metadata replaceable as a single filesystem operation.
function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

// Keep a torn verdict resumable instead of presenting a false completed state.
function hasValidVerdict(dir) {
  const verdict = readJsonFile(path.join(dir, "verdict.json"));
  return Boolean(
    verdict &&
    typeof verdict === "object" &&
    typeof verdict.label === "string" &&
    typeof verdict.call === "string" &&
    typeof verdict.recommended === "string"
  );
}

let running = null; // Anthropic API runner session id
let hybridRunning = null;
let hybridProcess = null;

// viewer: watches sessions written by Claude Code or another runner.
// api: original Anthropic API runner.
// hybrid: Gemini advisor seats + Copilot Student Chair through local authenticated CLIs.
const runnerSetting = (process.env.COUNCIL_RUNNER || env("COUNCIL_RUNNER") || "viewer").toLowerCase();
const RUNNER = runnerSetting === "api" || runnerSetting === "hybrid" ? runnerSetting : "viewer";
watch.startWatching();

function waitForHybridSetup(id, child, timeoutMs = 120000) {
  const marker = path.join(SESSIONS_DIR, id, "council.json");
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (fs.existsSync(marker)) return resolve();
      if (child.exitCode != null) return reject(new Error(`Hybrid runner exited before setup (code ${child.exitCode}).`));
      if (Date.now() - started > timeoutMs) return reject(new Error("Hybrid runner did not finish setup in time."));
      setTimeout(tick, 250);
    };
    tick();
  });
}

function hybridChildEnv() {
  const childEnv = { ...process.env };
  for (const key of ["CHAIR_PROVIDER", "GEMINI_CONCURRENCY", "GEMINI_MODEL", "GEMINI_CLI_ENTRY", "GEMINI_SEAT_RETRIES", "GEMINI_RETRY_BASE_MS", "COPILOT_CLI"]) {
    const value = env(key);
    if (value) childEnv[key] = value;
  }
  return childEnv;
}

function wireHybridChild(child, id) {
  hybridProcess = child;
  hybridRunning = id;
  let stderrTail = "";
  child.stdout.on("data", (d) => process.stdout.write(`[hybrid] ${d}`));
  child.stderr.on("data", (d) => {
    const text = d.toString();
    stderrTail = (stderrTail + text).slice(-6000);
    process.stderr.write(`[hybrid] ${text}`);
  });
  child.on("exit", (code, signal) => {
    const failed = code !== 0 || Boolean(signal);
    if (failed && !child.intentionalStop) {
      const exitLabel = signal ? `signal ${signal}` : `code ${code}`;
      const message = stderrTail.trim() || `Hybrid runner exited with ${exitLabel}.`;
      recordHybridFailure(id, code ?? -1, message);
      watch.fail(id, message);
    } else if (!failed) clearHybridFailure(id);
    if (hybridProcess === child) { hybridProcess = null; hybridRunning = null; }
  });
}

function isHybridResumable(id) {
  if (!/^[a-zA-Z0-9._-]+$/.test(id || "")) return false;
  const dir = path.join(SESSIONS_DIR, id);
  const councilPath = path.join(dir, "council.json");
  if (!fs.existsSync(councilPath) || hasValidVerdict(dir)) return false;
  return readJsonFile(councilPath)?.runner === "hybrid";
}

function failurePath(id) { return path.join(SESSIONS_DIR, id, "hybrid-error.json"); }
function clearHybridFailure(id) { try { fs.rmSync(failurePath(id), { force: true }); } catch {} }
function recordHybridFailure(id, code, message) {
  try {
    atomicWriteJson(failurePath(id), { at: new Date().toISOString(), code, message: String(message || "Hybrid runner failed").slice(-3000) });
  } catch {}
}
function hybridFailure(id) {
  return readJsonFile(failurePath(id));
}

// Keep provider diagnostics compact and free of prompts or generated content.
function hybridMetrics(id) {
  if (!/^[a-zA-Z0-9._-]+$/.test(id || "")) return null;
  const meta = readJsonFile(path.join(SESSIONS_DIR, id, "hybrid-meta.json"));
  const runs = Array.isArray(meta?.runs) ? meta.runs : [];
  const run = meta?.latest_run || runs[runs.length - 1];
  if (!run) return null;
  const calls = Array.isArray(run.provider_calls) ? run.provider_calls : [];
  const started = Date.parse(run.started_at || "");
  const savedDuration = Math.max(0, Number(run.duration_ms) || 0);
  const active = hybridRunning === id && hybridProcess && hybridProcess.exitCode == null;
  const duration = active && !run.completed_at && Number.isFinite(started)
    ? Math.max(savedDuration, Date.now() - started)
    : savedDuration;
  return {
    duration_ms: duration,
    provider_calls: calls.length,
    failed_calls: calls.filter((call) => call.ok === false).length,
    retries: calls.filter((call) => call.retry_scheduled).length,
    fallbacks: calls.filter((call) => call.ok && call.fallback).length,
    chair_providers: [...new Set(calls.filter((call) => call.ok && call.role === "chair").map((call) => call.provider))],
  };
}

function hybridProgress(id) {
  if (!/^[a-zA-Z0-9._-]+$/.test(id || "")) return null;
  const dir = path.join(SESSIONS_DIR, id);
  const councilPath = path.join(dir, "council.json");
  if (!fs.existsSync(councilPath)) return null;
  const council = readJsonFile(councilPath);
  if (!council || council.runner !== "hybrid") return null;
  const seats = (council.seats || []).filter(Boolean);
  const total = seats.length || (council.mode === "quick" ? 4 : 7);
  const countRound = (round) => {
    const jp = path.join(dir, `round-${round}.json`);
    if (fs.existsSync(jp)) {
      const saved = readJsonFile(jp);
      if (saved) return seats.filter((k) => saved.cards?.[k]).length;
    }
    const mp = path.join(dir, `round-${round}.md`);
    if (fs.existsSync(mp)) {
      try {
        const cards = watch.splitCards(fs.readFileSync(mp, "utf8"));
        return new Set(cards.map((c) => c.key).filter((k) => seats.includes(k))).size;
      } catch {}
    }
    return 0;
  };
  if (hasValidVerdict(dir)) return { phase: "verdict", label: "Complete", done: total, total };
  const r3 = countRound(3), r2 = countRound(2), r1 = countRound(1);
  if (readJsonFile(path.join(dir, "draft.json")) || r3) return { phase: "round3", label: `Vote ${r3}/${total}`, done: r3, total };
  if (readJsonFile(path.join(dir, "cruxes.json")) || r2) return { phase: "round2", label: `Debate ${r2}/${total}`, done: r2, total };
  if (r1) return { phase: "round1", label: `Openings ${r1}/${total}`, done: r1, total };
  return { phase: "setup", label: "Setting up", done: 0, total };
}

async function stopHybrid(id) {
  if (!hybridProcess || hybridProcess.exitCode != null || hybridRunning !== id) throw new Error("That Hybrid council is not currently running.");
  const child = hybridProcess;
  child.intentionalStop = true;
  watch.stop(id);
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
    });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  }
  if (hybridProcess === child) { hybridProcess = null; hybridRunning = null; }
}

async function startHybrid(prompt, mode) {
  if (hybridProcess && hybridProcess.exitCode == null) throw new Error("A Hybrid council is already running.");
  const id = `${new Date().toISOString().slice(0, 10)}-hybrid-${Date.now().toString(36)}`;
  clearHybridFailure(id);
  const args = [path.join(REPO_ROOT, "hybrid", "runner.mjs"), mode === "quick" ? "--quick" : "--full", "--session-id", id, prompt];
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, windowsHide: true, env: hybridChildEnv(), detached: process.platform !== "win32" });
  wireHybridChild(child, id);
  await waitForHybridSetup(id, child);
  return id;
}

async function resumeHybrid(id) {
  if (hybridProcess && hybridProcess.exitCode == null) throw new Error("A Hybrid council is already running.");
  if (!isHybridResumable(id)) throw new Error("This session cannot be resumed.");
  clearHybridFailure(id);
  const args = [path.join(REPO_ROOT, "hybrid", "runner.mjs"), "--resume", id];
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, windowsHide: true, env: hybridChildEnv(), detached: process.platform !== "win32" });
  wireHybridChild(child, id);
  watch.resume(id);
  await new Promise((resolve, reject) => setTimeout(() => child.exitCode && child.exitCode !== 0 ? reject(new Error(`Hybrid resume exited early (code ${child.exitCode}).`)) : resolve(), 200));
  return id;
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 1e5) throw new Error("body too large"); }
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === "/api/seats") return send(res, 200, { seats: SEATS, models: MODELS, runner: RUNNER, hasKey: Boolean(env("ANTHROPIC_API_KEY")) });
    if (p === "/api/usage") return send(res, 200, usage);
    if (p === "/api/council" && req.method === "POST") {
      if (RUNNER === "viewer") return send(res, 403, { error: "This room is viewer-only. Set COUNCIL_RUNNER=hybrid or api." });
      const { prompt, mode } = await readJson(req);
      if (!prompt || prompt.trim().length < 10) return send(res, 400, { error: "Give the council a real decision (at least a sentence)." });
      const cleanPrompt = prompt.trim().slice(0, 4000);
      if (RUNNER === "hybrid") {
        if (hybridProcess && hybridProcess.exitCode == null) return send(res, 409, { error: "A Hybrid council is already in session. Wait for its verdict." });
        const id = await startHybrid(cleanPrompt, mode === "quick" ? "quick" : "full");
        return send(res, 200, { id });
      }
      if (running && getSession(running)?.status === "running") return send(res, 409, { error: "A council is already in session. Wait for its verdict." });
      const s = startCouncil(cleanPrompt, mode === "quick" ? "quick" : "full");
      running = s.id;
      return send(res, 200, { id: s.id });
    }
    if (p.startsWith("/api/stream/")) {
      const id = decodeURIComponent(p.split("/").pop());
      const s = getSession(id) || watch.getLive(id);
      if (!s) return send(res, 404, { error: "no such session" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      res.on("close", () => clearInterval(ping));
      return subscribe(s, res);
    }
    if (p === "/api/sessions") {
      const active = RUNNER === "hybrid" ? hybridRunning : (running && getSession(running)?.status === "running" ? running : null);
      const all = [...listSaved(), ...watch.listLive()]
        .map((s) => ({
          ...s,
          resumable: RUNNER === "hybrid" && s.id !== active && isHybridResumable(s.id),
          stoppable: RUNNER === "hybrid" && s.id === active,
          progress: RUNNER === "hybrid" ? hybridProgress(s.id) : null,
          failure: RUNNER === "hybrid" ? hybridFailure(s.id) : null,
          metrics: RUNNER === "hybrid" ? hybridMetrics(s.id) : null,
        }))
        .sort((a, b) => (a.id < b.id ? 1 : -1));
      return send(res, 200, { sessions: all, running: active, live: watch.runningId() });
    }
    const resumeMatch = p.match(/^\/api\/sessions\/([^/]+)\/resume$/);
    if (resumeMatch && req.method === "POST") {
      if (RUNNER !== "hybrid") return send(res, 403, { error: "Resume is only available in Hybrid mode." });
      const id = decodeURIComponent(resumeMatch[1]);
      if (!isHybridResumable(id)) return send(res, 409, { error: "This session is complete, invalid, or not a Hybrid session." });
      const resumed = await resumeHybrid(id);
      return send(res, 200, { id: resumed });
    }
    const stopMatch = p.match(/^\/api\/sessions\/([^/]+)\/stop$/);
    if (stopMatch && req.method === "POST") {
      if (RUNNER !== "hybrid") return send(res, 403, { error: "Stop is only available in Hybrid mode." });
      const id = decodeURIComponent(stopMatch[1]);
      if (hybridRunning !== id || !hybridProcess || hybridProcess.exitCode != null) return send(res, 409, { error: "That Hybrid council is not currently running." });
      await stopHybrid(id);
      return send(res, 200, { id, status: "stopped", resumable: isHybridResumable(id), progress: hybridProgress(id) });
    }
    if (p.startsWith("/api/sessions/")) {
      const id = decodeURIComponent(p.split("/").pop());
      const x = watch.getLive(id);
      const j = loadSaved(id) || (x && { id, title: x.title, mode: x.mode, status: x.status, events: x.events });
      return j ? send(res, 200, j) : send(res, 404, { error: "not found" });
    }
    // static
    const file = path.normalize(path.join(PUBLIC, p === "/" ? "index.html" : p));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const label = RUNNER === "api" ? "Anthropic API runner" : RUNNER === "hybrid" ? "Hybrid: Gemini seats + Copilot Student Chair" : "viewer";
  console.log(`Roast Room on http://localhost:${PORT} (${label})`);
});
