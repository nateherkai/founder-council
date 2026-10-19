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

async function startHybrid(prompt, mode) {
  if (hybridProcess && hybridProcess.exitCode == null) throw new Error("A Hybrid council is already running.");
  const id = `${new Date().toISOString().slice(0, 10)}-hybrid-${Date.now().toString(36)}`;
  const args = [path.join(REPO_ROOT, "hybrid", "runner.mjs"), mode === "quick" ? "--quick" : "--full", "--session-id", id, prompt];
  const childEnv = { ...process.env };
  for (const key of ["CHAIR_PROVIDER", "GEMINI_CONCURRENCY", "GEMINI_MODEL", "GEMINI_CLI_ENTRY", "COPILOT_CLI"]) {
    const value = env(key);
    if (value) childEnv[key] = value;
  }
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, windowsHide: true, env: childEnv });
  hybridProcess = child;
  hybridRunning = id;
  child.stdout.on("data", (d) => process.stdout.write(`[hybrid] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[hybrid] ${d}`));
  child.on("exit", () => { if (hybridProcess === child) { hybridProcess = null; hybridRunning = null; } });
  await waitForHybridSetup(id, child);
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
      const all = [...listSaved(), ...watch.listLive()].sort((a, b) => (a.id < b.id ? 1 : -1));
      const active = RUNNER === "hybrid" ? hybridRunning : (running && getSession(running)?.status === "running" ? running : null);
      return send(res, 200, { sessions: all, running: active, live: watch.runningId() });
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
