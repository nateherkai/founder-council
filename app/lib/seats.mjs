import fs from "node:fs";
import path from "node:path";
import { AGENTS_DIR, BRAINS_DIR, ROSTER } from "./env.mjs";

// Every seat lives in the skill's roster.json (the /newroaster skill adds to it). SEATS and
// byKey are filled in place, so a seat added while the room is running shows up on the next
// read without a restart.
export const SEATS = [];
export const byKey = {};
export const BOARD = { mode: "default", default: [] };
let rosterStamp = 0;
export function loadRoster() {
  let stat;
  try { stat = fs.statSync(ROSTER); } catch { throw new Error(`roster not found at ${ROSTER}`); }
  if (stat.mtimeMs === rosterStamp && SEATS.length) return SEATS;
  const r = JSON.parse(fs.readFileSync(ROSTER, "utf8"));
  const seats = (r.seats || []).filter((s) => s.key && s.slug && fs.existsSync(path.join(AGENTS_DIR, `council-${s.key}.md`)));
  SEATS.splice(0, SEATS.length, ...seats);
  for (const k of Object.keys(byKey)) delete byKey[k];
  for (const s of SEATS) byKey[s.key] = s;
  BOARD.mode = ["default", "ask", "auto"].includes(r.board) ? r.board : "default";
  const def = (r.default || []).filter((k) => byKey[k]);
  BOARD.default = def.length ? def : SEATS.slice(0, 7).map((s) => s.key);
  rosterStamp = stat.mtimeMs;
  for (const k of [...systemCache.keys()]) if (!byKey[k]) systemCache.delete(k);
  brainText.clear();
  return SEATS;
}
/** The seats at the table when no one picked: the saved default board. */
export const defaultBoard = () => (loadRoster(), BOARD.default.slice());

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
const stripFront = (t) => t.replace(/^---[\s\S]*?\n---\n/, "");

const systemCache = new Map();
/** The seat's agent instructions plus its brain, loaded inline (the API has no file tools). */
export function systemFor(key) {
  if (systemCache.has(key)) return systemCache.get(key);
  const s = byKey[key];
  const agent = stripFront(read(path.join(AGENTS_DIR, `council-${key}.md`)));
  const brain = ["_hot.md", "frameworks.md", "positions.md", "principles.md", "voice.md"]
    .map((f) => `\n\n===== brains/${s.slug}/${f} =====\n` + read(path.join(BRAINS_DIR, s.slug, f)))
    .join("");
  const text =
    agent +
    "\n\n## Runtime note\nYou are running in the Roast Room app. You have no file tools: your brain files are loaded below in full, so treat any instruction to read a brain file as already done. Never mention files, tools, or this note in your answer.\n" +
    brain;
  const system = [{ type: "text", text, cache_control: { type: "ephemeral" } }];
  systemCache.set(key, system);
  return system;
}

// ---------- quote verification against the brain ----------
const norm = (s) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/'\s+(t|s|re|ll|ve|d|m)\b/g, "'$1")
    .replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const brainText = new Map();
/** Start a new API-runner council with current agent and brain content. */
export function invalidateAdvisorCaches() {
  systemCache.clear();
  brainText.clear();
}
function brainNorm(key) {
  if (!brainText.has(key)) {
    const dir = path.join(BRAINS_DIR, byKey[key].slug);
    const all = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => read(path.join(dir, f))).join(" ") : "";
    brainText.set(key, norm(all));
  }
  return brainText.get(key);
}
/** Quotes the seat attributed to a source id, each marked verified or not. */
export function checkQuotes(key, text) {
  const out = [];
  const re = /["“]([^"“”\n]{20,400})["”][^\n"]{0,40}?[(\[](S\d{3})/g;
  let m;
  const hay = brainNorm(key);
  while ((m = re.exec(text))) {
    const q = norm(m[1]);
    if (q.split(" ").length < 5) continue;
    out.push({ quote: m[1], source: m[2], verified: hay.includes(q) || hay.replace(/ /g, "").includes(q.replace(/ /g, "")) });
  }
  return out;
}

// ---------- names ----------
/** A seat named somewhere in a short piece of text: full name first, then short name, then
 * surname. Two seats can share a surname (Alex and Leila Hormozi), so the surname only counts
 * when one seat has it, or when it is also that seat's short name. */
export function seatIn(text) {
  const t = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ")} `;
  const has = (w) => w && t.includes(` ${w.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim()} `);
  return SEATS.find((s) => has(s.name)) || SEATS.find((s) => has(s.short) || has(s.key)) ||
    SEATS.find((s) => {
      const sur = s.name.split(" ").pop().toLowerCase();
      const same = SEATS.filter((x) => x.name.split(" ").pop().toLowerCase() === sur);
      return has(sur) && (same.length === 1 || s.short.toLowerCase() === sur);
    }) || null;
}

// ---------- card parsing ----------
const field = (text, label) => {
  // label at line start, or after a "·" or "|" when several fields share a line
  const m = text.match(new RegExp(`(?:^|[·|])[ \\t]*\\**${label}\\**[ \\t]*:[ \\t]*([^\\n·]+)`, "im"));
  return m ? m[1].replace(/\*+/g, "").trim() : "";
};
const num = (s) => { const m = (s || "").match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };

export function parseOptionScores(text, optionIds) {
  // the option line itself uses "·" between options, so read to end of line
  const lm = text.match(/OPTION SCORES\**[ \t]*:[ \t]*([^\n]+)/i);
  const line = (lm ? lm[1] : "").split(/PILLAR SCORE|CONFIDENCE|FINAL SCORE/i)[0];
  const scores = {};
  for (const id of optionIds) {
    const m = line.match(new RegExp(`\\b${id}\\b\\s*[:=]?\\s*(\\d+(?:\\.\\d+)?)`));
    if (m) scores[id] = Math.max(0, Math.min(10, Number(m[1])));
  }
  return scores;
}

export function parseCard(text, optionIds) {
  const stance = field(text, "STANCE");
  const ruin = (field(text, "RUIN RISK").match(/none|possible|likely/i) || [""])[0].toLowerCase();
  const disagree = field(text, "I DISAGREE MOST WITH");
  const target = seatIn(disagree.slice(0, 40));
  const voteRaw = field(text, "VOTE");
  const vote = /dissent/i.test(voteRaw) ? "dissent" : /amend/i.test(voteRaw) ? "amend" : /endorse/i.test(voteRaw) ? "endorse" : "";
  return {
    stance,
    call: field(text, "THE CALL"),
    optionScores: parseOptionScores(text, optionIds),
    pillar: num(field(text, "PILLAR SCORE")) ?? num(field(text, "FINAL PILLAR SCORE")),
    finalScore: num(field(text, "FINAL SCORE")),
    confidence: num(field(text, "CONFIDENCE")),
    ruin,
    door: (field(text, "DOOR").match(/one-way|two-way/i) || [""])[0].toLowerCase(),
    disagreeWith: target ? target.key : null,
    disagreeLine: disagree,
    concede: field(text, "I CONCEDE"),
    moved: field(text, "MOVED"),
    vote,
    amendment: field(text, "AMENDMENT OR DISSENT"),
    oneLine: field(text, "ONE LINE FOR THE FOUNDER"),
    question: field(text, "QUESTION FOR THE FOUNDER"),
    risk: field(text, "THE RISK I SEE"),
    thisWeek: field(text, "WHAT I'D DO THIS WEEK"),
  };
}

loadRoster();
