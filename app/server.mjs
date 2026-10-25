import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { APP_ROOT, env } from "./lib/env.mjs";
import { loadRoster, BOARD } from "./lib/seats.mjs";
import { startCouncil, getSession, subscribe, listSaved, loadSaved, MODELS } from "./lib/council.mjs";
import { usage } from "./lib/anthropic.mjs";
import * as watch from "./lib/watch.mjs";

const PORT = Number(process.env.PORT) || 4730;
const PUBLIC = path.join(APP_ROOT, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8" };

let running = null; // one council at a time (API runner)

// "viewer" (default): the room plays councils that /roast-room runs in Claude Code.
// "api": the room can also run councils itself on ANTHROPIC_API_KEY (COUNCIL_RUNNER=api in .env).
const RUNNER = (process.env.COUNCIL_RUNNER || env("COUNCIL_RUNNER") || "viewer").toLowerCase() === "api" ? "api" : "viewer";
watch.startWatching();

/* ---- Auth ---- */
const LOGIN_USER = process.env.LOGIN_USER || env("LOGIN_USER");
const LOGIN_PASS = process.env.LOGIN_PASS || env("LOGIN_PASS");
const AUTH_ENABLED = Boolean(LOGIN_USER && LOGIN_PASS);
const sessions = new Map(); // token → { user, created }
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const [k, ...v] = pair.trim().split("=");
    if (k) out[k.trim()] = decodeURIComponent(v.join("="));
  }
  return out;
}

function isAuthed(req) {
  if (!AUTH_ENABLED) return true;
  const token = parseCookies(req.headers.cookie).rr_session;
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() - s.created > SESSION_TTL) { sessions.delete(token); return false; }
  return true;
}

// Paths that don't need auth (login page + its assets)
function isPublicPath(p) {
  if (p === "/login.html" || p === "/login") return true;
  if (p === "/api/login") return true;
  // Allow brand assets and fonts so login page renders
  if (p.startsWith("/brand/")) return true;
  return false;
}
/* ---- end Auth ---- */

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
    /* ---- Login API ---- */
    if (p === "/api/login" && req.method === "POST") {
      if (!AUTH_ENABLED) return send(res, 200, { ok: true });
      const { user, pass } = await readJson(req);
      if (user === LOGIN_USER && pass === LOGIN_PASS) {
        const token = crypto.randomBytes(32).toString("hex");
        sessions.set(token, { user, created: Date.now() });
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": `rr_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`,
          "cache-control": "no-store",
        });
        return res.end(JSON.stringify({ ok: true }));
      }
      return send(res, 401, { error: "Wrong username or password" });
    }
    if (p === "/api/logout") {
      const token = parseCookies(req.headers.cookie).rr_session;
      if (token) sessions.delete(token);
      res.writeHead(302, {
        location: "login.html",
        "set-cookie": "rr_session=; Path=/; HttpOnly; Max-Age=0",
      });
      return res.end();
    }

    /* ---- Auth gate ---- */
    if (AUTH_ENABLED && !isPublicPath(p) && !isAuthed(req)) {
      if (p.startsWith("/api/")) return send(res, 401, { error: "Not authenticated" });
      // Redirect to login page
      res.writeHead(302, { location: "login.html" });
      return res.end();
    }

    if (p === "/api/seats") {
      // portraits: which of the four mouth shapes exist for each seat (a seat with none gets a drawn bust)
      const frame = (key, sh) => ["webp", "png", "jpg"].map((x) => `${key}-${sh}.${x}`).find((f) => fs.existsSync(path.join(PUBLIC, "portraits", f)));
      const seats = loadRoster().map((s) => ({ ...s, portraits: Object.fromEntries(["base", "open", "mid", "blink"].map((sh) => [sh, frame(s.key, sh)]).filter(([, f]) => f).map(([sh, f]) => [sh, `portraits/${f}`])) }));
      return send(res, 200, { seats, board: BOARD, models: MODELS, runner: RUNNER, hasKey: Boolean(env("ANTHROPIC_API_KEY")) });
    }
    if (p === "/api/usage") return send(res, 200, usage);
    if (p === "/api/council" && req.method === "POST") {
      if (RUNNER !== "api") return send(res, 403, { error: "This room is a viewer. Run /roast-room in Claude Code, or set COUNCIL_RUNNER=api in .env." });
      if (running && getSession(running)?.status === "running") return send(res, 409, { error: "A council is already in session. Wait for its verdict." });
      const { prompt, mode } = await readJson(req);
      if (!prompt || prompt.trim().length < 10) return send(res, 400, { error: "Give the council a real decision (at least a sentence)." });
      const s = startCouncil(prompt.trim().slice(0, 4000), mode === "quick" ? "quick" : "full");
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
      const apiRunning = running && getSession(running)?.status === "running" ? running : null;
      return send(res, 200, { sessions: all, running: apiRunning, live: watch.runningId() });
    }
    if (p.startsWith("/api/sessions/")) {
      const id = decodeURIComponent(p.split("/").pop());
      const x = watch.getLive(id);
      const j = loadSaved(id) || (x && { id, title: x.title, mode: x.mode, status: x.status, events: x.events });
      return j ? send(res, 200, j) : send(res, 404, { error: "not found" });
    }
    // static
    let file;
    if (p === "/login") {
      file = path.join(PUBLIC, "login.html");
    } else {
      file = path.normalize(path.join(PUBLIC, p === "/" ? "index.html" : p));
    }
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Roast Room on http://localhost:${PORT} (${RUNNER === "api" ? "viewer + API runner" : "viewer: run /roast-room in Claude Code"}${AUTH_ENABLED ? ", login required" : ""})`));
