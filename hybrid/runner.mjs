import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { classifyProviderError, createSessionTelemetry } from "./telemetry.mjs";
import { retryDelayMs, shouldRetryProviderError } from "./retry.mjs";
import { SEATS, byKey, systemFor, parseCard, checkQuotes } from "../app/lib/seats.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SESSIONS = path.join(ROOT, "sessions");
const SCHEMAS = path.join(HERE, "schemas");

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv(path.join(ROOT, ".env"));

const NPM_BIN = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"), "npm");
const GEMINI = process.env.GEMINI_CLI_ENTRY || path.join(NPM_BIN, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
const COPILOT_DEFAULT = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages", "GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe", "copilot.exe");
const COPILOT = process.env.COPILOT_CLI || (fs.existsSync(COPILOT_DEFAULT) ? COPILOT_DEFAULT : "copilot.exe");
const COPILOT_ENTRY = process.env.COPILOT_CLI_ENTRY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "";
const CHAIR_PROVIDER = (process.env.CHAIR_PROVIDER || "copilot").toLowerCase();
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.GEMINI_CONCURRENCY || 2)));
function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}
const SEAT_RETRIES = boundedInt(process.env.GEMINI_SEAT_RETRIES, 1, 0, 2);
const RETRY_BASE_MS = boundedInt(process.env.GEMINI_RETRY_BASE_MS, 1500, 250, 30000);
const GEMINI_TIMEOUT_MS = boundedInt(process.env.GEMINI_TIMEOUT_MS, 10 * 60_000, 50, 60 * 60_000);
const COPILOT_TIMEOUT_MS = boundedInt(process.env.COPILOT_TIMEOUT_MS, 3 * 60_000, 50, 60 * 60_000);
const DISCLAIMER = "Simulated advisors built from each person's public work. They are not the people and do not speak for them.";

const argv = process.argv.slice(2);
let quick = false, full = false, forcedId = "", resumeId = "";
const words = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--quick") quick = true;
  else if (argv[i] === "--full") full = true;
  else if (argv[i] === "--session-id") forcedId = argv[++i] || "";
  else if (argv[i] === "--resume") resumeId = argv[++i] || "";
  else words.push(argv[i]);
}
let mode = quick && !full ? "quick" : "full";
const prompt = words.join(" ").trim();
for (const [label, value] of [["--session-id", forcedId], ["--resume", resumeId]]) {
  if (value && !/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`Invalid ${label}`);
}
if (resumeId && forcedId) throw new Error("Use either --resume or --session-id, not both");
const telemetry = createSessionTelemetry({ resumed: Boolean(resumeId) });
if (!prompt && !resumeId) {
  console.log("Usage: npm run hybrid -- [--quick|--full] [--session-id id] \"your business decision and context\"");
  console.log("   or: npm run hybrid -- --resume SESSION_ID");
  process.exit(2);
}

function slugify(s) {
  return String(s || "council").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 55) || "council";
}
function cleanText(s) {
  return String(s || "").replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}
// Keep session checkpoints replaceable as a single filesystem operation.
function atomicWriteFile(p, text) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, p);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}
// Keep legacy and interrupted sessions recoverable when optional JSON is malformed.
function readJsonFile(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (error) {
    console.warn(`Ignoring invalid JSON checkpoint ${path.basename(p)}: ${error.message}`);
    return null;
  }
}
function writeJson(p, obj) { atomicWriteFile(p, JSON.stringify(obj, null, 2) + "\n"); }
function writeText(p, text) {
  const value = String(text);
  atomicWriteFile(p, value.replace(/\r\n/g, "\n") + (value.endsWith("\n") ? "" : "\n"));
}
// Keep diagnostics best-effort so telemetry never blocks a council.
function attachTelemetry(metaPath, base) {
  telemetry.attach(base, (doc) => {
    try { writeJson(metaPath, doc); }
    catch (error) { console.warn(`Telemetry write failed: ${error.message}`); }
  });
}

function runProcess(entry, args, input, timeoutMs = 8 * 60_000) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(entry)) return reject(new Error(`CLI entry not found: ${entry}`));
    const child = spawn(process.execPath, [entry, ...args], { cwd: ROOT, windowsHide: true, shell: false, env: process.env });
    let out = "", err = "";
    child.stdout.on("data", (d) => out += d.toString());
    child.stderr.on("data", (d) => err += d.toString());
    const timer = setTimeout(() => {
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      else try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`Timed out: ${path.basename(entry)}`));
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(entry)} exited ${code}: ${(err || out).slice(-4000)}`));
    });
    child.stdin.end(input || "");
  });
}

async function geminiText(task) {
  const args = ["-p", "Use the instructions and task supplied on stdin. Output only the requested answer, with no markdown fence.", "--approval-mode", "plan", "--skip-trust", "-o", "text"];
  if (GEMINI_MODEL) args.push("-m", GEMINI_MODEL);
  const { out } = await runProcess(GEMINI, args, task, GEMINI_TIMEOUT_MS);
  return cleanText(out);
}

function runExecutable(exe, args, input, timeoutMs = 5 * 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: HERE, windowsHide: true, shell: false, env: process.env });
    let out = "", err = "";
    child.stdout.on("data", (d) => out += d.toString());
    child.stderr.on("data", (d) => err += d.toString());
    const timer = setTimeout(() => {
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      else try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`Timed out: ${exe}`));
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${exe} exited ${code}: ${(err || out).slice(-4000)}`));
    });
    child.stdin.end(input || "");
  });
}

function parseJsonOutput(text) {
  const clean = cleanText(String(text || "").replace(/^\uFEFF/, ""));
  const a = clean.indexOf("{");
  const b = clean.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("Chair returned no JSON object");
  return JSON.parse(clean.slice(a, b + 1));
}

function jsonTask(kind, task) {
  const schema = fs.readFileSync(path.join(SCHEMAS, `${kind}.json`), "utf8");
  return `Return ONLY one valid JSON object, no markdown and no commentary. It must satisfy this JSON Schema exactly:\n${schema}\n\nTASK:\n${task}`;
}

async function copilotJson(kind, task) {
  const chairDir = path.join(HERE, "chair-work");
  fs.mkdirSync(chairDir, { recursive: true });
  const args = [
    "-C", chairDir,
    "-p", jsonTask(kind, task),
    "--silent", "--mode", "plan", "--no-custom-instructions", "--disable-builtin-mcps",
    "--allow-all-tools", "--excluded-tools", "shell", "write", "--deny-tool", "shell", "--deny-tool", "write", "--no-remote", "--no-remote-export"
  ];
  const { out } = COPILOT_ENTRY
    ? await runProcess(COPILOT_ENTRY, args, "", COPILOT_TIMEOUT_MS)
    : await runExecutable(COPILOT, args, "", COPILOT_TIMEOUT_MS);
  return parseJsonOutput(out);
}

async function geminiJson(kind, task) {
  return parseJsonOutput(await geminiText(jsonTask(kind, task)));
}

const chairProvidersUsed = new Set();
async function chairJson(kind, task) {
  if (CHAIR_PROVIDER === "gemini") {
    const started = Date.now();
    try {
      const result = await geminiJson(kind, task);
      telemetry.provider({ role: "chair", task: kind, provider: "gemini-cli", ok: true, duration_ms: Date.now() - started });
      chairProvidersUsed.add("gemini-cli");
      return result;
    } catch (error) {
      telemetry.provider({ role: "chair", task: kind, provider: "gemini-cli", ok: false, duration_ms: Date.now() - started, error_type: classifyProviderError(error) });
      throw error;
    }
  }
  const copilotStarted = Date.now();
  try {
    const result = await copilotJson(kind, task);
    telemetry.provider({ role: "chair", task: kind, provider: "github-copilot-student", ok: true, duration_ms: Date.now() - copilotStarted });
    chairProvidersUsed.add("github-copilot-student");
    return result;
  } catch (error) {
    telemetry.provider({ role: "chair", task: kind, provider: "github-copilot-student", ok: false, duration_ms: Date.now() - copilotStarted, error_type: classifyProviderError(error) });
    console.warn(`Copilot Chair failed (${error.message}). Falling back to Gemini Chair.`);
    const fallbackStarted = Date.now();
    try {
      const result = await geminiJson(kind, task);
      telemetry.provider({ role: "chair", task: kind, provider: "gemini-cli", ok: true, fallback: true, duration_ms: Date.now() - fallbackStarted });
      chairProvidersUsed.add("gemini-cli-fallback");
      return result;
    } catch (fallbackError) {
      telemetry.provider({ role: "chair", task: kind, provider: "gemini-cli", ok: false, fallback: true, duration_ms: Date.now() - fallbackStarted, error_type: classifyProviderError(fallbackError) });
      throw fallbackError;
    }
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length); let next = 0;
  async function worker() { while (true) { const i = next++; if (i >= items.length) return; results[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const seatNames = Object.fromEntries(SEATS.map((s) => [s.key, s.short]));
function optionsLine(st) { return st.options.map((o) => `${o.id} n/10`).join(" · "); }
function briefBlock(st) {
  return `THE DECISION: ${st.decision}\nOPTIONS:\n${st.options.map((o) => `(${o.id}) ${o.label}`).join("\n")}\n\n${st.brief}\n\nASSUMPTIONS:\n${(st.assumptions || []).map((a) => `- ${a}`).join("\n") || "- none"}`;
}
const seatContextCache = new Map();
function seatContext(key) {
  if (!seatContextCache.has(key)) seatContextCache.set(key, systemFor(key)?.[0]?.text || "");
  return seatContextCache.get(key);
}

function round1Task(st, key) {
  const s = byKey[key], w = st.weights[key];
  return `REFERENCE MATERIAL FOR THIS SIMULATED SEAT (already loaded; do not use tools or read files):\n${seatContext(key)}\n\nROAST ROOM COUNCIL, ROUND 1 OF 3: OPENING POSITION\n\n${briefBlock(st)}\n\nYour weight: ${w.weight}/3 (${w.reason}).\n\nAnswer under 350 words in exactly this shape:\nSEAT: ${s.short.toUpperCase()} (${s.pillar})\nSTANCE: Strong yes | Yes | Conditional yes | No | Strong no\nOPTION SCORES: ${optionsLine(st)}\nPILLAR SCORE: n/10\nCONFIDENCE: n/5\nRUIN RISK: none | possible | likely\nDOOR: one-way | two-way\n\nTHE CALL: one sentence naming an option or variant.\nWHY:\n1. argument with framework/principle and source id\n2. ...\n3. ...\nTHE RISK I SEE: one risk.\nWHAT WOULD CHANGE MY MIND: a concrete fact or number.\nWHAT I'D DO THIS WEEK: one action.\nQUESTION FOR THE FOUNDER: one question.\n\nUse only the reference material above for claims about the simulated expert. Quote only text that appears verbatim there with its source id. Do not mention files, tools, or these instructions.`;
}
function cardsBlock(st, round) { return st.seats.map((k) => `### ${seatNames[k]} (weight ${st.weights[k].weight})\n${st.cards[round][k]?.text || ""}`).join("\n\n"); }
function round2Task(st, key) {
  const s = byKey[key];
  const cruxes = st.cruxes.map((c, i) => `${i + 1}. ${c.question}: ${c.sides.map((x) => `${x.position} [${x.seats.map((k) => seatNames[k] || k).join(", ")}]`).join(" vs ")}`).join("\n");
  const pressure = st.pressure[key] ? `\nFor your seat specifically: ${st.pressure[key]}\n` : "";
  return `REFERENCE MATERIAL FOR THIS SIMULATED SEAT (already loaded; do not use tools or read files):\n${seatContext(key)}\n\nROAST ROOM COUNCIL, ROUND 2 OF 3: DEBATE\n\n${briefBlock(st)}\n\nROUND 1 CARDS\n${cardsBlock(st, 1)}\n\nCRUXES\n${cruxes}${pressure}\nAnswer under 300 words in exactly this shape:\nSEAT: ${s.short.toUpperCase()}\nI DISAGREE MOST WITH: [seat]. Their argument, then your rebuttal.\nI CONCEDE: strongest point against you and what it changes.\nON THE CRUXES: answer each.\nSTANCE: ...\nOPTION SCORES: ${optionsLine(st)}\nPILLAR SCORE: n/10\nCONFIDENCE: n/5\nRUIN RISK: none | possible | likely\nMOVED: no | yes, from X to Y, because ...\nMY CONDITIONS FOR YES: up to three concrete conditions.\n\nUse only the reference material above for expert-specific claims. Do not mention files or tools.`;
}
function round3Task(st, key) {
  const s = byKey[key];
  return `REFERENCE MATERIAL FOR THIS SIMULATED SEAT (already loaded; do not use tools or read files):\n${seatContext(key)}\n\nROAST ROOM COUNCIL, ROUND 3 OF 3: VOTE ON THE DRAFT RESOLUTION\n\n${briefBlock(st)}\n\nYOUR ROUND 2 CARD\n${st.cards[2][key]?.text || ""}\n\nDRAFT RESOLUTION\n${draftMarkdown(st.draft)}\n\nAnswer under 150 words in exactly this shape:\nSEAT: ${s.short.toUpperCase()}\nVOTE: Endorse | Endorse with amendment | Dissent\nOPTION SCORES: ${optionsLine(st)}\nFINAL SCORE: n/10\nFINAL PILLAR SCORE: n/10\nAMENDMENT OR DISSENT: one or two sentences, blank if endorse.\nONE LINE FOR THE FOUNDER: one line.\n\nUse only the reference material above for expert-specific claims. Do not mention files or tools.`;
}

function scoreOptions(st, round) {
  const out = {};
  for (const o of st.options) {
    let n = 0, d = 0; const parts = [];
    for (const k of st.seats) {
      const v = st.cards[round][k]?.parsed.optionScores[o.id]; const w = st.weights[k].weight;
      if (typeof v === "number") { n += w * v; d += w; parts.push(`${w}x${v}`); }
    }
    out[o.id] = { score: d ? Math.round(n / d * 10) / 10 : null, math: d ? `(${parts.join(" + ")}) / ${d}` : "" };
  }
  return out;
}
function band(score) { return score >= 7.5 ? "GO" : score >= 6 ? "GO WITH CONDITIONS" : score >= 4.5 ? "RESHAPE" : "DON'T DO IT"; }
function finalStats(st, round) {
  const scores = scoreOptions(st, round);
  const recommended = Object.entries(scores).sort((a, b) => (b[1].score ?? -1) - (a[1].score ?? -1))[0][0];
  const vals = st.seats.map((k) => st.cards[round][k]?.parsed.optionScores[recommended]).filter(Number.isFinite);
  const confs = st.seats.map((k) => st.cards[2][k]?.parsed.confidence ?? st.cards[1][k]?.parsed.confidence).filter(Number.isFinite);
  const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  const confidence = confs.length ? Math.max(1, Math.min(10, Math.round(confs.reduce((a,b)=>a+b,0)/confs.length*2) - (spread >= 5 ? 1 : 0))) : null;
  return { scores, recommended, spread, confidence };
}

function writeRound(st, round, chairNotes = "") {
  const body = st.seats.filter((k) => st.cards[round][k]).map((k) => `## ${byKey[k].name} (weight ${st.weights[k].weight})\n\n${st.cards[round][k].text}`).join("\n\n");
  writeText(path.join(st.dir, `round-${round}.md`), `# Round ${round}\n\n${body}${chairNotes ? `\n\n## Chair notes\n\n${chairNotes}` : ""}\n`);
}
function writeRoundState(st, round) {
  writeJson(path.join(st.dir, `round-${round}.json`), { round, cards: st.cards[round], scores: scoreOptions(st, round) });
}
function loadRoundState(st, round) {
  const jsonPath = path.join(st.dir, `round-${round}.json`);
  const saved = readJsonFile(jsonPath);
  if (saved) {
    st.cards[round] = saved.cards || {};
    st.scores[round] = saved.scores || scoreOptions(st, round);
    return;
  }
  const mdPath = path.join(st.dir, `round-${round}.md`);
  if (!fs.existsSync(mdPath)) return;
  const sections = fs.readFileSync(mdPath, "utf8").split(/^## /m).slice(1);
  for (const section of sections) {
    const nl = section.indexOf("\n");
    const heading = (nl >= 0 ? section.slice(0, nl) : section).trim();
    if (/^Chair notes/i.test(heading)) continue;
    const key = st.seats.find((k) => heading.startsWith(byKey[k].name));
    if (!key) continue;
    const text = (nl >= 0 ? section.slice(nl + 1) : "").trim();
    if (!text) continue;
    const parsed = parseCard(text, st.options.map((o) => o.id));
    st.cards[round][key] = { text, parsed, quotes: checkQuotes(key, text) };
  }
  if (Object.keys(st.cards[round]).length) {
    st.scores[round] = scoreOptions(st, round);
    writeRoundState(st, round);
  }
}
function roundComplete(st, round) { return st.seats.every((k) => st.cards[round]?.[k]); }
function briefMarkdown(st) {
  return `# ${st.title}\n\nAsked: ${prompt}\n\n${st.brief}\n\nOptions:\n${st.options.map((o)=>`- ${o.id}: ${o.label}`).join("\n")}\n\nAssumptions:\n${(st.assumptions||[]).map((a)=>`- ${a}`).join("\n") || "- none"}\n\n| Seat | Weight | Reason |\n|---|---|---|\n${SEATS.map((s)=>`| ${s.short} | ${st.weights[s.key].weight} | ${st.weights[s.key].reason} |`).join("\n")}\n`;
}
function draftMarkdown(d) {
  return `# Draft resolution\n\n## ${d.label}: Option ${d.option}\n\n${d.recommendation}\n\n## Conditions\n${d.conditions.map((x,i)=>`${i+1}. ${x}`).join("\n")}\n\n## Next steps\n${d.next_steps.map((x)=>`- ${x}`).join("\n")}\n\n**Cheapest test:** ${d.cheapest_test}\n\n**Kill criteria:** ${d.kill_criteria}\n`;
}
function verdictMarkdown(st, v, stats, rounds) {
  const label = st.options.find((o)=>o.id===stats.recommended)?.label || stats.recommended;
  const L = [`# Roast Room: ${st.title}`, "", `${new Date().toISOString().slice(0,10)} · Seats: ${st.seats.map((k)=>seatNames[k]).join(", ")} · Rounds: ${rounds} · Mode: ${mode} · Hybrid: Gemini seats + Copilot Student Chair`, "", `## Verdict: ${v.label} (Option ${stats.recommended}: ${label})`, "", `**The call:** ${v.call}`, "", `Option scores: ${st.options.map((o)=>`${o.id} ${stats.scores[o.id]?.score ?? "-"}`).join(" · ")} · Confidence ${stats.confidence ?? "-"}/10 · Spread ${stats.spread}`];
  if (v.override_note) L.push("", v.override_note);
  L.push("", `Math: ${st.options.map((o)=>`${o.id} ${stats.scores[o.id]?.math} = ${stats.scores[o.id]?.score}`).join(" · ")}`, "", "## Why the council landed here", "", ...v.why.map((x)=>`- ${x.point} (${x.seat}, ${x.framework})`), "", "## Where they fought", "", ...v.fights.map((x)=>`- **${x.crux}** ${x.story}`), "", "## Minority report", "", `${v.minority.seat}: \"${v.minority.quote}\" For this to be right: ${v.minority.would_have_to_be_true}`, "", "## Conditions", "", ...v.conditions.map((x,i)=>`${i+1}. ${x}`), "", "## What to do next", "", ...v.next_steps.map((x)=>`- **${x.when}:** ${x.action}`), "", `**Cheapest test:** ${v.cheapest_test}`, `**Kill criteria:** ${v.kill_criteria}`, `**Revisit:** ${v.revisit}`, "", "---", DISCLAIMER, "");
  return L.join("\n");
}

async function generateSeatCard(st, round, key, taskFn) {
  const maxAttempts = 1 + SEAT_RETRIES;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    try {
      const text = await geminiText(taskFn(st, key));
      const parsed = parseCard(text, st.options.map((o)=>o.id));
      if (Object.keys(parsed.optionScores).length < st.options.length) throw new Error(`${seatNames[key]} returned an invalid score card in round ${round}`);
      telemetry.provider({ role: "seat", task: `round-${round}`, seat: key, provider: "gemini-cli", ok: true, attempt, duration_ms: Date.now() - started });
      return { text, parsed };
    } catch (error) {
      const errorType = classifyProviderError(error);
      const retryScheduled = attempt < maxAttempts && shouldRetryProviderError(errorType);
      telemetry.provider({ role: "seat", task: `round-${round}`, seat: key, provider: "gemini-cli", ok: false, attempt, retry_scheduled: retryScheduled, duration_ms: Date.now() - started, error_type: errorType });
      if (!retryScheduled) throw error;
      const delay = retryDelayMs(attempt, RETRY_BASE_MS);
      console.warn(`Gemini ${round}.${seatNames[key]} hit ${errorType}; retrying in ${delay}ms.`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`Gemini ${round}.${seatNames[key]} exhausted retry policy`);
}

async function runRound(st, round, taskFn) {
  st.cards[round] ||= {};
  const missing = st.seats.filter((key) => !st.cards[round][key]);
  if (!missing.length) {
    st.scores[round] = scoreOptions(st, round);
    console.log(`Round ${round}: already complete, reusing saved cards.`);
    return st.scores[round];
  }
  await mapLimit(missing, CONCURRENCY, async (key) => {
    console.log(`  Gemini ${round}.${seatNames[key]}...`);
    const { text, parsed } = await generateSeatCard(st, round, key, taskFn);
    st.cards[round][key] = { text, parsed, quotes: checkQuotes(key, text) };
    writeRound(st, round);
    writeRoundState(st, round);
  });
  st.scores[round] = scoreOptions(st, round);
  writeRoundState(st, round);
  return st.scores[round];
}

let setup, st, dir;
if (resumeId) {
  dir = path.join(SESSIONS, resumeId);
  const councilPath = path.join(dir, "council.json");
  if (!fs.existsSync(councilPath)) throw new Error(`Cannot resume: missing council.json in ${resumeId}`);
  const saved = readJsonFile(councilPath);
  if (!saved) throw new Error(`Cannot resume: invalid council.json in ${resumeId}`);
  if (saved.runner !== "hybrid") throw new Error(`Cannot resume non-hybrid session: ${resumeId}`);
  const verdictPath = path.join(dir, "verdict.json");
  const done = readJsonFile(verdictPath);
  if (done && typeof done.label === "string" && typeof done.call === "string" && typeof done.recommended === "string") {
    console.log(`Session ${resumeId} is already complete.`);
    console.log("Verdict:", done.label, "|", done.call);
    console.log("Full report:", path.join(dir, "verdict.md"));
    process.exit(0);
  }
  mode = saved.mode || mode;
  setup = { title:saved.title, decision:saved.decision, options:saved.options || [], brief:saved.brief || "", assumptions:saved.assumptions || [] };
  const weights = saved.weights || Object.fromEntries(SEATS.map((s)=>[s.key,{weight:1,reason:""}]));
  const seats = (saved.seats || SEATS.map((s)=>s.key)).filter((k)=>byKey[k]);
  st = { ...setup, weights, seats, dir, cards:{1:{},2:{},3:{}}, scores:{} };
  for (const r of [1,2,3]) loadRoundState(st, r);
  const cruxPath = path.join(dir, "cruxes.json");
  const crux = readJsonFile(cruxPath);
  if (crux) {
    st.cruxes = crux.cruxes;
    st.pressure = Object.fromEntries((crux.pressure || []).map((x)=>[x.seat,x.ask]));
  }
  const draftPath = path.join(dir, "draft.json");
  const savedDraft = readJsonFile(draftPath);
  if (savedDraft) st.draft = savedDraft;
  const metaPath = path.join(dir, "hybrid-meta.json");
  const meta = readJsonFile(metaPath) || {};
  attachTelemetry(metaPath, { ...meta, resumed_at:new Date().toISOString(), gemini_model:GEMINI_MODEL||meta.gemini_model||"cli-default", concurrency:CONCURRENCY, seat_retries:SEAT_RETRIES, retry_base_ms:RETRY_BASE_MS });
  console.log(`Resuming session: ${resumeId}`);
} else {
  setup = await chairJson("setup", `You are the neutral Chair of Roast Room. Seven simulated seats: Bezos=strategy/reversibility, Graham=product/startups, Hormozi=offers/pricing/sales, Gary V=marketing/attention, Martell=people/founder time, Wickman=operations/scaling, Buffett=money/capital.\n\nFounder prompt:\n${prompt}\n\nCreate a faithful decision brief using only supplied facts. Do not invent facts; put necessary gaps in assumptions. Options must be 2 to 4 entries and use ids A, B, C, D in order. Include status quo/do-not-do-it and a smaller reversible version where sensible. Give every seat weight 1-3, exactly one or two seats at weight 3. quick_seats must be four unique seats: two most relevant, Bezos or Buffett as downside check, and a likely dissenter.`);
  const ids = ["A","B","C","D"];
  setup.options = (setup.options || []).slice(0,4).map((o,i) => ({ id: ids[i], label: String(o.label || o.id || `Option ${ids[i]}`) }));
  if (setup.options.length < 2) throw new Error("Chair returned fewer than two options");
  const weights = Object.fromEntries(SEATS.map((s)=>[s.key,{weight:1,reason:""}]));
  for (const w of setup.weights || []) if (weights[w.seat]) weights[w.seat] = { weight: Math.max(1,Math.min(3,w.weight)), reason:w.reason };
  let seats = mode === "quick" ? [...new Set(setup.quick_seats || [])].filter((k)=>byKey[k]).slice(0,4) : SEATS.map((s)=>s.key);
  for (const s of SEATS) if (mode === "quick" && seats.length < 4 && !seats.includes(s.key)) seats.push(s.key);
  const id = forcedId || `${new Date().toISOString().slice(0,10)}-${slugify(setup.title)}-hybrid`;
  dir = path.join(SESSIONS,id); let bump=2;
  if (!forcedId) while (fs.existsSync(dir)) dir = path.join(SESSIONS,`${id}-${bump++}`);
  else if (fs.existsSync(dir)) throw new Error(`Session already exists: ${id}`);
  fs.mkdirSync(dir,{recursive:true});
  st = { ...setup, weights, seats, dir, cards:{1:{},2:{},3:{}}, scores:{} };
  writeText(path.join(dir,"brief.md"), briefMarkdown(st));
  writeJson(path.join(dir,"council.json"), { title:st.title, decision:st.decision, mode, options:st.options, weights:st.weights, seats:st.seats, brief:st.brief, assumptions:st.assumptions, runner:"hybrid", providers:{seats:"gemini-cli",chair:CHAIR_PROVIDER === "gemini" ? "gemini-cli" : "github-copilot-student"} });
  const metaPath = path.join(dir,"hybrid-meta.json");
  attachTelemetry(metaPath, { created:new Date().toISOString(), mode, providers:{seats:"gemini-cli",chair_requested:CHAIR_PROVIDER}, gemini_model:GEMINI_MODEL||"cli-default", concurrency:CONCURRENCY, seat_retries:SEAT_RETRIES, retry_base_ms:RETRY_BASE_MS });
}
console.log(`Hybrid Roast Room: ${mode} council${resumeId ? " (resume)" : ""}`);
console.log(`Chair: ${CHAIR_PROVIDER === "gemini" ? "Gemini (test/fallback mode)" : "GitHub Copilot Student (Gemini fallback)"} | Seats: Gemini | Seat concurrency: ${CONCURRENCY} | Seat retries: ${SEAT_RETRIES}`);
console.log("Session:", dir);
console.log("Watch: http://localhost:4730");

console.log("Round 1...");
await runRound(st,1,round1Task);
const cruxPath = path.join(dir,"cruxes.json");
let crux = readJsonFile(cruxPath);
if (crux) {
  console.log("Cruxes: reusing saved Chair analysis.");
} else {
  crux = await chairJson("cruxes", `You are the neutral Chair. Do not argue a side.\n\n${briefBlock(st)}\n\nROUND 1 CARDS\n${cardsBlock(st,1)}\n\nIdentify 1-3 underlying cruxes explaining the split. For each side use seat keys only. If every seat chose the same top option and scores are within 1, set unanimous=true and force the strongest unargued alternative into a crux. pressure contains only minority/unanimity-challenge seats and the argument they must answer.`);
  writeJson(cruxPath,crux);
}
st.cruxes=crux.cruxes; st.pressure=Object.fromEntries((crux.pressure||[]).map((x)=>[x.seat,x.ask]));
writeRound(st,1,`${crux.note}\n\n${crux.cruxes.map((c,i)=>`${i+1}. ${c.question}`).join("\n")}`);
writeRoundState(st,1);

console.log("Round 2...");
const s2=await runRound(st,2,round2Task);
writeRound(st,2,`Interim scores: ${st.options.map((o)=>`${o.id} ${s2[o.id]?.score}`).join(" · ")}`);
writeRoundState(st,2);
let round=2, draft=st.draft||null;
const top2=Object.entries(s2).sort((a,b)=>(b[1].score??-1)-(a[1].score??-1))[0][0];
const vals2=st.seats.map((k)=>st.cards[2][k]?.parsed.optionScores[top2]).filter(Number.isFinite);
const spread2=vals2.length?Math.max(...vals2)-Math.min(...vals2):0;
const ruin2=st.seats.some((k)=>st.cards[2][k]?.parsed.ruin==="likely");
const skip3=mode==="quick"&&spread2<=3&&!ruin2;
if(!skip3){
  if (!draft) {
    draft=await chairJson("draft",`You are the neutral Chair.\n\n${briefBlock(st)}\n\nROUND 2 CARDS\n${cardsBlock(st,2)}\n\nComputed scores: ${JSON.stringify(Object.fromEntries(Object.entries(s2).map(([k,v])=>[k,v.score])))}. Band rules: 7.5+ GO; 6.0-7.4 GO WITH CONDITIONS; 4.5-5.9 RESHAPE; under 4.5 DON'T DO IT. WAIT when a good option needs an unmet prerequisite. RUIN RISK likely caps at RESHAPE until mitigated. Draft a resolution with merged, checkable conditions, dated next steps, cheapest test, kill criteria.`);
    st.draft=draft; writeText(path.join(dir,"draft-resolution.md"),draftMarkdown(draft)); writeJson(path.join(dir,"draft.json"),draft);
  } else console.log("Draft: reusing saved Chair resolution.");
  console.log("Round 3..."); await runRound(st,3,round3Task); round=3;
  writeRound(st,3,"Final ratification round complete."); writeRoundState(st,3);
} else console.log(`Quick mode: skipping Round 3 (spread ${spread2}, no likely ruin risk).`);

const stats=finalStats(st,round);
const unverified=[]; for(const r of [1,2,3]) for(const k of st.seats) for(const q of st.cards[r]?.[k]?.quotes||[]) if(!q.verified) unverified.push({round:r,seat:k,quote:q.quote,source:q.source});
writeJson(path.join(dir,"quote-check.json"),{unverified,count:unverified.length});
const verdict=await chairJson("verdict",`You are the neutral Chair. Write the final founder verdict. Do not invent seat claims.\n\n${briefBlock(st)}\n\nCRUXES: ${JSON.stringify(st.cruxes)}\n\nROUND 2 CARDS\n${cardsBlock(st,2)}\n\n${round===3?`DRAFT: ${JSON.stringify(draft)}\nROUND 3 CARDS\n${cardsBlock(st,3)}`:"Round 3 was skipped under quick-mode convergence rules."}\n\nCOMPUTED FINAL SCORES (do not change): ${JSON.stringify(Object.fromEntries(Object.entries(stats.scores).map(([k,v])=>[k,v.score])))}\nRecommended by score: ${stats.recommended}; normal band: ${band(stats.scores[stats.recommended]?.score)}; spread: ${stats.spread}; confidence: ${stats.confidence}.\nUnverified source-attributed quotes that must NOT be repeated as real-person quotes: ${JSON.stringify(unverified)}.\n\nUse WAIT only for a real unmet prerequisite; apply ruin/one-way-door caps when justified. minority.quote must copy words from a seat card, not claim the real person said them.`);
verdict.recommended=stats.recommended;
writeText(path.join(dir,"verdict.md"),verdictMarkdown(st,verdict,stats,round));
writeJson(path.join(dir,"verdict.json"),verdict);
telemetry.complete({ chair_providers_used: [...chairProvidersUsed] });
console.log("DONE");
console.log("Verdict:", verdict.label, "|", verdict.call);
console.log("Scores:", st.options.map((o)=>`${o.id}=${stats.scores[o.id]?.score}`).join(" "));
console.log("Full report:", path.join(dir,"verdict.md"));
console.log("Room: http://localhost:4730");
