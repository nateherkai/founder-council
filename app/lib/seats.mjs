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
    // a single quote used as a quotation mark (not inside a word, like don't) is punctuation
    .replace(/(?<![a-z0-9])'|'(?![a-z0-9])/g, " ")
    .replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const brainText = new Map();
const brainLineList = new Map();
function brainNorm(key) {
  if (!brainText.has(key)) {
    const dir = path.join(BRAINS_DIR, byKey[key].slug);
    const all = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => read(path.join(dir, f))).join("\n") : "";
    brainText.set(key, norm(all));
    brainLineList.set(key, all.split("\n").filter((l) => l.trim()).map((l) => ({ text: norm(l), ids: l.match(/S\d{3}/g) || [] })));
  }
  return brainText.get(key);
}
// a closing quote, then a source id within 40 characters: "..." (S095), "..." [S048, 2026],
// or "..." (Lead magnets, S112). Same rules as scripts/check_quotes.py.
const CLOSE_THEN_ID = /["”](?=[^\n"“”]{0,40}?[(\[](?:[^()\[\]\n"“”]{0,30}?,\s*)?(S\d{3}))/g;
// whether the quote mark at line[i] opens a quote (curly marks say so; straight ones by context)
function isOpen(line, i) {
  const ch = line[i];
  if (ch === "“" || ch === "”") return ch === "“";
  const next = line[i + 1] ?? " ", prev = line[i - 1] ?? " ";
  // a mark right before "(" or "[" closes a quote, as in get,"(S011)
  return !/\s/.test(next) && !"([".includes(next) && !(/[A-Za-z0-9]/.test(prev) || ".!?".includes(prev));
}
// The quote whose closing mark is line[end]: scan back, so a nested quote stays inside it, an
// earlier separate quote stays out, and an opening mark that never closes widens it.
function quoteEndingAt(line, end) {
  let depth = 1, start = null;
  for (let i = end - 1; i >= 0; i--) {
    if (!'"“”'.includes(line[i])) continue;
    if (!isOpen(line, i)) { depth++; continue; }
    depth--;
    if (start === null && depth === 0) start = i + 1;
    else if (depth < 0) { start = i + 1; depth = 0; }
  }
  return start === null ? null : line.slice(start, end);
}
/** Quotes the seat attributed to a source id, each marked verified or not. */
// "...", "…" or "[...]" marks words left out of a quote; GAP is the most normalized characters it may stand for
const ELLIPSIS = /\[?(?:\.\.\.|…)\]?/;
const GAP = 300;
// each piece of a shortened quote must have this many words, so "The ... of ... the" proves nothing
const MIN_PIECE_WORDS = 3;

// Whether the quote is in the normalized text hay. A quote with ellipses verifies when its pieces
// appear in order, as whole words, each within GAP of the one before, and each is MIN_PIECE_WORDS long.
function inText(quote, hay) {
  const parts = quote.split(ELLIPSIS).map(norm).filter(Boolean).map((p) => ` ${p} `);
  if (parts.length <= 1) {
    const q = norm(quote);
    return hay.includes(q) || hay.replace(/ /g, "").includes(q.replace(/ /g, ""));
  }
  if (parts.some((p) => p.trim().split(" ").length < MIN_PIECE_WORDS)) return false;
  const padded = ` ${hay} `;
  for (let i = padded.indexOf(parts[0]); i !== -1; i = padded.indexOf(parts[0], i + 1)) {
    let pos = i + parts[0].length - 1;
    let ok = true;
    for (const p of parts.slice(1)) {
      const j = padded.indexOf(p, pos);
      if (j === -1 || j - pos > GAP) { ok = false; break; }
      pos = j + p.length - 1;
    }
    if (ok) return true;
  }
  return false;
}

/**
 * `context` is what the seat may quote besides its brain: the brief and earlier rounds. A quote found
 * there but not in the brain is marked `context: true` (quoting the founder or a seat, not the expert).
 */
// The ids the brain cites the quote under, when none of them is sid; null when sid fits. A brain line with
// no id, or a quote that only matches across lines, can't be checked, so it passes.
function citedElsewhere(key, quote, sids) {
  const first = quote.split(ELLIPSIS).map(norm).find(Boolean) || "";
  const hits = brainLineList.get(key).filter((l) => ` ${l.text} `.includes(` ${first} `) && inText(quote, l.text));
  if (!hits.length || hits.some((l) => !l.ids.length || l.ids.some((id) => sids.includes(id)))) return null;
  return [...new Set(hits.flatMap((l) => l.ids))].sort();
}

export function checkQuotes(key, text, context = "") {
  const out = [];
  const hay = brainNorm(key);
  const ctx = norm(context);
  for (const line of text.split("\n")) {
    for (const m of line.matchAll(CLOSE_THEN_ID)) {
      if (isOpen(line, m.index)) continue;
      const quote = quoteEndingAt(line, m.index);
      if (quote === null || quote.length < 20 || quote.length > 400) continue;
      const q = norm(quote);
      if (q.split(" ").length < 5) continue;
      const inBrain = inText(quote, hay);
      // every id in the citation counts, as in (S090, S028)
      const cite = line.slice(m.index + 1).match(/^[^\n"“”]{0,40}?[(\[][^()\[\]\n]{0,80}/);
      const sids = cite ? cite[0].match(/S\d{3}/g) : [m[1]];
      const citedAs = inBrain ? citedElsewhere(key, quote, sids) : null;
      const verified = inBrain && !citedAs;
      out.push({ quote, source: m[1], verified, citedAs, context: !inBrain && Boolean(ctx) && inText(quote, ctx) });
    }
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
