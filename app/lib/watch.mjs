// Viewer mode: /roast-room runs in Claude Code and writes its session folder as it
// goes. This watches the sessions folder and turns those files into the same events the
// API runner emits, so the room plays a Claude Code council live without calling any API.
//
// Files the Chair writes, in order (spec: .claude/skills/roast-room/references/live-room.md):
//   council.json  -> setup        round-1.md -> Round 1 cards   cruxes.json -> fault lines
//   round-2.md    -> debate cards  draft.json -> proposal       round-3.md  -> votes
//   verdict.json  -> the verdict
import fs from "node:fs";
import path from "node:path";
import { SEATS, byKey, parseCard, checkQuotes, loadRoster, defaultBoard, seatIn } from "./seats.mjs";
import { SESSIONS_DIR } from "./env.mjs";
import { optionScores, finalNumbers, verdictSeats, DISCLAIMER } from "./council.mjs";

const live = new Map(); // folder name -> session
const STALE_MS = 3 * 60 * 60 * 1000; // a folder untouched this long is an abandoned council

const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const readJson = (p) => { const t = readText(p); if (!t) return null; try { return JSON.parse(t); } catch { return null; } };

/** "Gary V", "garyvee", "GARY V (Marketing)", "Warren Buffett" -> seat key */
export function seatKey(x) {
  const t = String(x || "").toLowerCase().replace(/\(.*$/, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return SEATS.find((s) => t === s.key || t === s.short.toLowerCase() || t === s.name.toLowerCase())?.key || seatIn(t)?.key || null;
}

/** Split a round file into seat cards. A card is the text under a "## <Seat>" heading
 * (how the skill writes them); without seat headings, each "SEAT:" line starts a card.
 * Chair sections are dropped. */
export function splitCards(md) {
  const heads = [...md.matchAll(/^#{2,3}[ \t]+(.+)$/gm)];
  const seatHeads = heads.filter((h) => !/chair/i.test(h[1]) && seatKey(h[1]));
  if (seatHeads.length) {
    return seatHeads.map((h) => {
      const next = heads.find((n) => n.index > h.index);
      const text = md.slice(h.index + h[0].length, next ? next.index : md.length).replace(/(\n\s*(-{3,}|\*{3,}))+\s*$/g, "").trim();
      return { key: seatKey(h[1]), text };
    }).filter((c) => c.text);
  }
  const body = md.split(/^#{1,4}[^\n]*\bchair\b[^\n]*$/im)[0];
  const marks = [...body.matchAll(/^\**SEAT\**[ \t]*:[ \t]*(.+)$/gim)];
  return marks.map((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
    const text = body.slice(m.index, end).replace(/(\n\s*(#{1,4} [^\n]*|-{3,}|\*{3,}))+\s*$/g, "").trim();
    return { key: seatKey(m[1]), text };
  }).filter((c) => c.key);
}

function emit(x, type, data = {}) {
  const ev = { type, t: Date.now() - x.started, ...data };
  x.events.push(ev);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of x.subs) res.write(line);
}

function finish(x, status) {
  x.status = status;
  for (const res of x.subs) res.write(`data: ${JSON.stringify({ type: "end" })}\n\n`);
  x.subs.clear();
}

function normalizeSetup(c) {
  const options = (c.options || []).map((o, i) => (typeof o === "string" ? { id: "ABCD"[i], label: o } : { id: String(o.id || "ABCD"[i]).toUpperCase(), label: o.label || o.text || "" }));
  loadRoster(); // pick up a seat added since the room started
  const weights = Object.fromEntries(SEATS.map((s) => [s.key, { weight: 1, reason: "" }]));
  const wl = Array.isArray(c.weights) ? c.weights : Object.entries(c.weights || {}).map(([seat, w]) => (typeof w === "number" ? { seat, weight: w } : { seat, ...w }));
  for (const w of wl) { const k = seatKey(w.seat); if (k) weights[k] = { weight: Math.max(1, Math.min(3, Number(w.weight) || 1)), reason: w.reason || "" }; }
  const seats = (c.seats || []).map(seatKey).filter(Boolean);
  const mode = c.mode === "quick" ? "quick" : "full";
  return {
    title: c.title || "Roast Room", decision: c.decision || "", brief: c.brief || "", mode,
    options, assumptions: c.assumptions || [], weights,
    seats: seats.length ? [...new Set(seats)] : defaultBoard(),
  };
}

// `at` is when the step began (the mtime of the file that started it), so a viewer who
// opens the room halfway through a round still sees how long the room has been waiting.
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return Date.now(); } };

function startRound(x, r, label, at) {
  const st = x.st;
  st.rounds.push(r);
  x.round = r;
  emit(x, "phase", { phase: `round${r}`, label, at });
  emit(x, "round_start", { round: r, at });
  for (const k of st.seats) emit(x, "seat_start", { round: r, seat: k });
}

/** What a round-r card may quote besides the brain: the brief and the cards of earlier rounds. */
function quoteContext(x, r) {
  const st = x.st;
  const earlier = st.rounds.filter((n) => n < r).flatMap((n) => Object.values(st.cards[n] || {}).map((c) => c.text));
  return [st.decision, st.brief, readText(path.join(x.dir, "brief.md")) || "", ...earlier].join("\n");
}

/** Emit the cards in a round file that have not been emitted yet. Returns true once the round is complete. */
function readRound(x, r, force) {
  const st = x.st;
  const md = readText(path.join(x.dir, `round-${r}.md`));
  if (!md) return false;
  for (const c of splitCards(md)) {
    if (!st.seats.includes(c.key) || st.cards[r][c.key]) continue;
    const parsed = parseCard(c.text, st.options.map((o) => o.id));
    const quotes = checkQuotes(c.key, c.text, quoteContext(x, r));
    st.cards[r][c.key] = { text: c.text, parsed, quotes };
    emit(x, "seat_done", { round: r, seat: c.key, text: c.text, parsed, quotes, name: byKey[c.key].name });
  }
  const have = st.seats.filter((k) => st.cards[r][k]).length;
  if (have === st.seats.length || (force && have > 0)) {
    st.scores[r] = optionScores(st, r);
    emit(x, "round_done", { round: r, scores: st.scores[r] });
    return true;
  }
  return false;
}

function sync(x) {
  const f = (n) => path.join(x.dir, n);
  const has = (n) => fs.existsSync(f(n));
  const st = x.st;

  if (x.step === "setup") {
    const c = readJson(f("council.json"));
    if (!c) return;
    Object.assign(st, normalizeSetup(c));
    x.title = st.title;
    x.mode = st.mode;
    emit(x, "phase", { phase: "setup", label: "The Chair is reading your question", at: mtime(f("council.json")) });
    emit(x, "setup", { title: st.title, decision: st.decision, brief: st.brief, options: st.options, assumptions: st.assumptions, weights: st.weights, seats: st.seats, mode: st.mode });
    startRound(x, 1, "Round 1: opening positions", mtime(f("council.json")));
    x.step = "r1";
  }
  if (x.step === "r1") {
    if (!readRound(x, 1, has("cruxes.json"))) return;
    emit(x, "phase", { phase: "cruxes", label: "The Chair is finding the fault lines", at: mtime(f("round-1.md")) });
    x.step = "cruxes";
  }
  if (x.step === "cruxes") {
    const c = readJson(f("cruxes.json"));
    if (!c) return;
    const cruxes = (c.cruxes || []).map((q) => ({ question: q.question || "", sides: (q.sides || []).map((sd) => ({ position: sd.position || "", seats: (sd.seats || []).map(seatKey).filter(Boolean) })) }));
    emit(x, "cruxes", { cruxes, unanimous: Boolean(c.unanimous), note: c.note || "", pressure: {} });
    startRound(x, 2, "Round 2: the debate", mtime(f("cruxes.json")));
    x.step = "r2";
  }
  if (x.step === "r2") {
    if (!readRound(x, 2, has("draft.json") || has("verdict.json"))) return;
    emit(x, "phase", { phase: "draft", label: "The Chair is weighing the debate", at: mtime(f("round-2.md")) });
    x.step = "draft";
  }
  if (x.step === "draft") {
    const d = readJson(f("draft.json"));
    if (d) {
      st.draft = { option: d.option || "", label: d.label || "", recommendation: d.recommendation || "", conditions: d.conditions || [], next_steps: d.next_steps || [], cheapest_test: d.cheapest_test || "", kill_criteria: d.kill_criteria || "" };
      emit(x, "draft", { draft: st.draft });
      startRound(x, 3, "Round 3: the vote", mtime(f("draft.json")));
      x.step = "r3";
    } else if (has("verdict.json")) {
      emit(x, "phase", { phase: "skip3", label: "Quick mode: the vote round is skipped", at: mtime(f("round-2.md")) });
      x.step = "verdict";
    } else return;
  }
  if (x.step === "r3") {
    if (!readRound(x, 3, has("verdict.json"))) return;
    emit(x, "phase", { phase: "verdict", label: "The Chair is writing the verdict", at: mtime(f("round-3.md")) });
    x.step = "verdict";
  }
  if (x.step === "verdict") {
    const v = readJson(f("verdict.json"));
    if (!v) return;
    const { last, finalScores, recommended, spreadF, confidence, support, votes } = finalNumbers(st);
    const verdict = {
      label: v.label || "RESHAPE", call: v.call || "", override_note: v.override_note || "",
      why: v.why || [], fights: v.fights || [], minority: v.minority || { seat: "", quote: "", would_have_to_be_true: "" },
      amendments: v.amendments || [], conditions: v.conditions || [],
      next_steps: (v.next_steps || []).map((n) => (typeof n === "string" ? { when: "", action: n } : n)),
      cheapest_test: v.cheapest_test || "", kill_criteria: v.kill_criteria || "", revisit: v.revisit || "",
      recommended: v.recommended || recommended, scores: finalScores, spread: spreadF, confidence, support, votes, disclaimer: DISCLAIMER,
    };
    emit(x, "verdict", { verdict, seats: verdictSeats(st, last) });
    x.step = "done";
    finish(x, "done");
  }
}

function lastTouched(dir) {
  try { return Math.max(...fs.readdirSync(dir).map((n) => fs.statSync(path.join(dir, n)).mtimeMs)); } catch { return 0; }
}

function load(name) {
  const dir = path.join(SESSIONS_DIR, name);
  let x = live.get(name);
  if (!x) {
    x = { id: name, dir, events: [], subs: new Set(), status: "running", started: Date.now(), step: "setup", title: "", mode: "full",
      st: { cards: { 1: {}, 2: {}, 3: {} }, scores: {}, rounds: [] } };
    live.set(name, x);
  }
  if (x.status === "running") {
    sync(x);
    if (x.status === "running" && Date.now() - lastTouched(dir) > STALE_MS) finish(x, "stopped");
  }
  return x;
}

/** Folders written by the skill (council.json, no events.json from the API runner). */
function skillFolders() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR).filter((d) => fs.existsSync(path.join(SESSIONS_DIR, d, "council.json")) && !fs.existsSync(path.join(SESSIONS_DIR, d, "events.json")));
}

export function scan() {
  for (const name of skillFolders()) load(name);
}

export function getLive(id) {
  return skillFolders().includes(id) ? load(id) : null;
}

/** The council running right now in Claude Code, if any (newest first). */
export function runningId() {
  const r = [...live.values()].filter((x) => x.status === "running" && x.events.length).sort((a, b) => (a.id < b.id ? 1 : -1));
  return r[0]?.id || null;
}

export function listLive() {
  return skillFolders().map((n) => { const x = load(n); return { id: x.id, title: x.title || n, prompt: "", mode: x.mode, status: x.status, source: "claude-code" }; });
}

export function startWatching() {
  scan();
  setInterval(scan, 1000);
}
