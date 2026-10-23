import fs from "node:fs";
import path from "node:path";
import { SEATS, BOARD, byKey, systemFor, parseCard, checkQuotes, defaultBoard, loadRoster, invalidateAdvisorCaches } from "./seats.mjs";
import * as ai from "./anthropic.mjs";
import { S } from "./anthropic.mjs";
import { SESSIONS_DIR } from "./env.mjs";

export const MODELS = {
  seat: process.env.SEAT_MODEL || "claude-sonnet-5-5",
  chair: process.env.CHAIR_MODEL || "claude-opus-5-5",
};

// The board comes from the roster: the saved default board, or every seat it lists.
const chairSystem = (st) => {
  const seats = st.board.map((k) => byKey[k]);
  return `You are the Chair of a Roast Room council: ${seats.length} simulated advisors built from the public work of ${seats.map((x) => `${x.name} (${x.pillar.toLowerCase()})`).join(", ")}.
You never argue a side and never add your own pillar. You run the room, keep score, and write in plain English: short sentences, no em dashes, no hype, no tee-ups like "here's the thing", no filler. Seat keys (for key fields only): ${seats.map((x) => x.key).join(", ")}. Whenever you write a seat's name in prose or in a seat field, use its display name: ${seats.map((x) => x.short).join(", ")}.`;
};

export const DISCLAIMER = "Simulated advisors built from each person's public work. They are not the people and do not speak for them.";

// ---------------------------------------------------------------- sessions
const sessions = new Map();
export const getSession = (id) => sessions.get(id);

function slugify(t) {
  return (t || "council").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "council";
}

function newSession(prompt, mode) {
  const id = `${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`;
  const s = { id, prompt, mode, status: "running", events: [], subs: new Set(), started: Date.now(), state: {} };
  sessions.set(id, s);
  return s;
}

function emit(s, type, data = {}) {
  const ev = { type, t: Date.now() - s.started, ...data };
  // text deltas are streamed live but not stored one by one; the final card is stored
  if (type !== "delta") s.events.push(ev);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of s.subs) res.write(line);
}

export function subscribe(s, res) {
  for (const ev of s.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (s.status !== "running") { res.write(`data: ${JSON.stringify({ type: "end" })}\n\n`); return; }
  s.subs.add(res);
  res.on("close", () => s.subs.delete(res));
}

// ---------------------------------------------------------------- prompts
function briefBlock(st) {
  const opts = st.options.map((o) => `(${o.id}) ${o.label}`).join("\n");
  return `THE DECISION: ${st.decision}\n\nOPTIONS:\n${opts}\n\n${st.brief}\n\nAssumptions the Chair made (marked as assumed; challenge them if they matter):\n${st.assumptions.map((a) => `- ${a}`).join("\n")}`;
}
const optLine = (st) => st.options.map((o) => `${o.id} n/10`).join(" · ");

function round1Prompt(st, seat) {
  const w = st.weights[seat.key];
  return `ROAST ROOM COUNCIL, ROUND 1 OF 3: OPENING POSITION

You hold the ${seat.short.toUpperCase()} seat (${seat.pillar}).

THE BRIEF
${briefBlock(st)}

Your weight on this decision: ${w.weight}/3 (${w.reason}).

Answer in your seat's voice, first person, plain text, under 300 words, in exactly this shape:

SEAT: ${seat.short.toUpperCase()} (${seat.pillar})
STANCE: Strong yes | Yes | Conditional yes | No | Strong no   (on the option you recommend)
OPTION SCORES: ${optLine(st)}
PILLAR SCORE: n/10   (${seat.dimension}: the option you recommend, judged on your pillar alone)
CONFIDENCE: n/5
RUIN RISK: none | possible | likely
DOOR: one-way | two-way

THE CALL: one sentence, naming the option or a variant.
WHY:
1. argument, naming the framework or principle you used and its source id, e.g. (Value Equation, S014)
2. ...
3. ...
THE RISK I SEE: the single biggest thing that goes wrong.
WHAT WOULD CHANGE MY MIND: a concrete fact or number.
WHAT I'D DO THIS WEEK: one action.
QUESTION FOR THE FOUNDER: the one question you would ask before signing off.

Rules: argue from your pillar first. Use real numbers when the brief has them, and say which numbers you are assuming. Quote only verbatim lines from your brain, with the source id. Do not hedge to sound balanced; the Chair balances the council.`;
}

function cardsBlock(st, round) {
  return st.seats.map((k) => `### ${byKey[k].short} (weight ${st.weights[k].weight})\n${st.cards[round][k]?.text || "(no card)"}`).join("\n\n");
}

function round2Prompt(st, seat) {
  const cr = st.cruxes.map((c, i) => `${i + 1}. ${c.question} (${c.sides.map((x) => `${x.position}: ${x.seats.map((k) => byKey[k]?.short || k).join(", ")}`).join("; ")})`).join("\n");
  const push = st.pressure?.[seat.key] ? `\nFor you specifically: ${st.pressure[seat.key]}\n` : "";
  return `ROAST ROOM COUNCIL, ROUND 2 OF 3: DEBATE

You hold the ${seat.short.toUpperCase()} seat.

THE BRIEF
${briefBlock(st)}

ROUND 1, EVERY SEAT'S CARD
${cardsBlock(st, 1)}

THE CRUXES THE CHAIR SEES
${cr}
${push}
Answer in your seat's voice, first person, plain text, under 280 words, in exactly this shape:

SEAT: ${seat.short.toUpperCase()}
I DISAGREE MOST WITH: [seat name]. Their argument, in one line, then your rebuttal using your frameworks.
I CONCEDE: the strongest point another seat made against you, and what it changes. "Nothing" only if you can say why their best point fails.
ON THE CRUXES: your answer to each crux, one or two lines each.
STANCE: ...
OPTION SCORES: ${optLine(st)}
PILLAR SCORE: n/10
CONFIDENCE: n/5
RUIN RISK: none | possible | likely
MOVED: no | yes, from X to Y, because ...
MY CONDITIONS FOR YES: up to three, concrete and checkable (a number, a date, a test result).

Rules: engage the actual arguments on the table. Move only for a better argument, never to be agreeable. If everyone agrees with you, attack the weakest part of your own case.`;
}

function round3Prompt(st, seat) {
  const d = st.draft;
  return `ROAST ROOM COUNCIL, ROUND 3 OF 3: VOTE ON THE DRAFT RESOLUTION

You hold the ${seat.short.toUpperCase()} seat.

THE BRIEF
${briefBlock(st)}

YOUR ROUND 2 CARD
${st.cards[2][seat.key]?.text || ""}

THE CHAIR'S DRAFT RESOLUTION
Recommendation: ${d.label} on option ${d.option}. ${d.recommendation}
Conditions:
${d.conditions.map((c) => `- ${c}`).join("\n")}
Next steps:
${d.next_steps.map((c) => `- ${c}`).join("\n")}
Cheapest test: ${d.cheapest_test}
Kill criteria: ${d.kill_criteria}

Answer in your seat's voice, first person, under 140 words, in exactly this shape:

SEAT: ${seat.short.toUpperCase()}
VOTE: Endorse | Endorse with amendment | Dissent
OPTION SCORES: ${optLine(st)}   (given the resolution's conditions)
FINAL SCORE: n/10   (your support for the draft resolution as written)
FINAL PILLAR SCORE: n/10
AMENDMENT OR DISSENT: one or two sentences. Blank if you endorse.
ONE LINE FOR THE FOUNDER: the thing from your pillar they must not forget.`;
}

// ---------------------------------------------------------------- scoring
export function optionScores(st, round) {
  const out = {};
  for (const o of st.options) {
    let num = 0, den = 0;
    const parts = [];
    for (const k of st.seats) {
      const v = st.cards[round][k]?.parsed.optionScores[o.id];
      const w = st.weights[k].weight;
      if (typeof v === "number") { num += w * v; den += w; parts.push(`${w}x${v}`); }
    }
    out[o.id] = { score: den ? Math.round((num / den) * 10) / 10 : null, math: den ? `(${parts.join(" + ")}) / ${den}` : "" };
  }
  return out;
}

function bandFor(score) {
  if (score == null) return "RESHAPE";
  if (score >= 7.5) return "GO";
  if (score >= 6) return "GO WITH CONDITIONS";
  if (score >= 4.5) return "RESHAPE";
  return "DON'T DO IT";
}

// ---------------------------------------------------------------- chair calls
async function chairSetup(st) {
  const schema = S.obj({
    title: S.str,
    decision: S.str,
    brief: S.str,
    options: S.arr(S.obj({ id: S.enum("A", "B", "C", "D"), label: S.str })),
    assumptions: S.arr(S.str),
    weights: S.arr(S.obj({ seat: S.enum(...st.board), weight: S.int, reason: S.str })),
    quick_seats: S.arr(S.enum(...st.board)),
    seats: S.arr(S.enum(...st.board)),
  });
  return ai.json({
    model: MODELS.chair, system: chairSystem(st), schema, maxTokens: 3000,
    prompt: `A founder brought this to the council:

"""${st.prompt}"""

Set up the room.
- title: the decision in 3 to 7 words.
- decision: one line.
- options: 2 to 4 options with ids A, B, C (D only if truly needed). Always include "don't do it" or "keep doing what you do now", and the obvious smaller version if the founder brought one big idea.
- brief: under 200 words covering the business, resources, what success looks like, and the founder's lean, using only what the founder said. Do not invent facts.
- assumptions: any number or fact you had to assume to make the brief usable, each one line. Keep it to what matters.
- weights: one entry for every seat, weight 1 to 3 (3 = the decision lives in this pillar, 2 = materially affected, 1 = touched at the edges). Exactly one or two seats at 3. Reason in one line.
- quick_seats: the four seats for a quick council: the two highest-weight seats, the seat that guards the downside (money, capital, or risk) if it is not already in, and the seat most likely to disagree with the others.
- seats: ${st.pick ? "the board for a full council, five to seven seats: every seat at weight 2 or 3, the seat that guards the downside, and the seat most likely to disagree. Leave out seats at weight 1 unless they are the downside or dissent seat." : "every seat (the board is fixed)."}`,
  });
}

async function chairCruxes(st) {
  const schema = S.obj({
    cruxes: S.arr(S.obj({ question: S.str, sides: S.arr(S.obj({ position: S.str, seats: S.arr(S.enum(...st.board)) })) })),
    unanimous: S.bool,
    note: S.str,
    pressure: S.arr(S.obj({ seat: S.enum(...st.board), ask: S.str })),
  });
  return ai.json({
    model: MODELS.chair, system: chairSystem(st), schema, maxTokens: 3000,
    prompt: `${briefBlock(st)}

ROUND 1 CARDS
${cardsBlock(st, 1)}

Name the one to three cruxes: the underlying disagreements that explain why seats split (a fact, a number, or a value such as speed versus safety), with the seats on each side.
Unanimity check: if every seat's top option is the same and their scores for it sit within 1 point, set unanimous true, make the strongest unargued alternative a crux, and say which seats whose pillars are most at risk must argue it at full strength.
note: one or two plain sentences for the founder on what the room is fighting about.
pressure: for each seat that holds a minority view, or that the unanimity check names, one sentence telling it exactly which argument it must answer in Round 2. Leave others out.`,
  });
}

async function chairDraft(st, interim) {
  const schema = S.obj({
    option: S.str,
    label: S.enum("GO", "GO WITH CONDITIONS", "RESHAPE", "WAIT", "DON'T DO IT"),
    recommendation: S.str,
    conditions: S.arr(S.str),
    next_steps: S.arr(S.str),
    cheapest_test: S.str,
    kill_criteria: S.str,
  });
  return ai.json({
    model: MODELS.chair, system: chairSystem(st), schema, maxTokens: 3000,
    prompt: `${briefBlock(st)}

ROUND 2 CARDS (the debate)
${cardsBlock(st, 2)}

Interim weighted option scores: ${JSON.stringify(Object.fromEntries(Object.entries(interim).map(([k, v]) => [k, v.score])))}
Band rule: 7.5+ GO, 6.0 to 7.4 GO WITH CONDITIONS, 4.5 to 5.9 RESHAPE, under 4.5 DON'T DO IT. Use WAIT when the top option is good but depends on a prerequisite not met yet. Overrides: any seat at RUIN RISK likely caps at RESHAPE until a mitigation it endorsed is in the conditions.

Write the draft resolution. Weigh arguments, not headcount: one seat with a decisive fact beats three with vibes. Merge duplicate conditions, keep each checkable (a number or a date), and where seats gave different numbers pick one and say whose. Next steps carry dates or day counts. recommendation is one or two sentences.`,
  });
}

async function chairVerdict(st, finalScores, recommended) {
  const lastRound = st.rounds.at(-1);
  const schema = S.obj({
    label: S.enum("GO", "GO WITH CONDITIONS", "RESHAPE", "WAIT", "DON'T DO IT"),
    call: S.str,
    override_note: S.str,
    why: S.arr(S.obj({ point: S.str, seat: S.str, framework: S.str })),
    fights: S.arr(S.obj({ crux: S.str, story: S.str })),
    minority: S.obj({ seat: S.str, quote: S.str, would_have_to_be_true: S.str }),
    amendments: S.arr(S.obj({ seat: S.str, amendment: S.str, adopted: S.bool, reason: S.str })),
    conditions: S.arr(S.str),
    next_steps: S.arr(S.obj({ when: S.str, action: S.str })),
    cheapest_test: S.str,
    kill_criteria: S.str,
    revisit: S.str,
  });
  return ai.json({
    model: MODELS.chair, system: chairSystem(st), schema, maxTokens: 5000,
    prompt: `${briefBlock(st)}

CRUXES: ${JSON.stringify(st.cruxes)}

ROUND 2 CARDS
${cardsBlock(st, 2)}

${lastRound === 3 ? `DRAFT RESOLUTION\n${JSON.stringify(st.draft)}\n\nROUND 3 VOTES\n${cardsBlock(st, 3)}` : "(Quick mode: Round 3 skipped.)"}

FINAL WEIGHTED OPTION SCORES (computed, do not change): ${JSON.stringify(Object.fromEntries(Object.entries(finalScores).map(([k, v]) => [k, v.score])))}
Recommended option by score: ${recommended}. Band for it: ${bandFor(finalScores[recommended]?.score)}.
Any seat at ruin risk likely: ${st.seats.filter((k) => st.cards[lastRound][k]?.parsed.ruin === "likely" || st.cards[2][k]?.parsed.ruin === "likely").join(", ") || "none"}.

Write the verdict for the founder.
- label: the band, or WAIT if the recommended option depends on an unmet prerequisite, or a cap from an override. If you change the band, say why in override_note; otherwise override_note is "".
- call: one or two sentences the founder can act on, naming the option.
- why: 3 to 5 arguments that carried the room, each tagged with the seat and the framework.
- fights: one entry per crux: who was on each side, who moved and why, how it resolved.
- minority: the strongest losing view; quote copies the seat's own words exactly from a card; would_have_to_be_true in one line. If unanimous, use the least-tested assumption instead.
- amendments: every Round 3 amendment, adopted or not, with the reason (empty in quick mode). Adopt when no seat objected or the argument went unanswered.
- conditions, next_steps (with when), cheapest_test, kill_criteria, revisit: final, merged, checkable.`,
  });
}

// ---------------------------------------------------------------- the run
async function runSeat(s, st, round, key, prompt) {
  const seat = byKey[key];
  emit(s, "seat_start", { round, seat: key });
  let text = "";
  try {
    text = await ai.stream({
      model: MODELS.seat, system: systemFor(key), maxTokens: 1400,
      messages: [{ role: "user", content: prompt }],
      onText: (d) => { text += d; emit(s, "delta", { round, seat: key, text: d }); },
    });
  } catch (e) {
    emit(s, "seat_error", { round, seat: key, error: String(e.message || e) });
    throw e;
  }
  const parsed = parseCard(text, st.options.map((o) => o.id));
  const quotes = checkQuotes(key, text);
  st.cards[round][key] = { text, parsed, quotes };
  emit(s, "seat_done", { round, seat: key, text, parsed, quotes, name: seat.name });
}

async function roundAll(s, st, round, promptFn) {
  emit(s, "round_start", { round });
  // stagger starts slightly so speech bubbles open in a ripple around the table
  await Promise.all(st.seats.map((k, i) => new Promise((r) => setTimeout(r, i * 350)).then(() => runSeat(s, st, round, k, promptFn(st, byKey[k])))));
  const scores = optionScores(st, round);
  st.scores[round] = scores;
  emit(s, "round_done", { round, scores });
}

export function startCouncil(prompt, mode = "full") {
  const s = newSession(prompt, mode);
  run(s).catch((e) => {
    s.status = "error";
    emit(s, "error", { error: String(e.message || e) });
    for (const res of s.subs) res.write(`data: ${JSON.stringify({ type: "end" })}\n\n`);
    save(s);
  });
  return s;
}

async function run(s) {
  // "default" seats the saved default board; "ask" and "auto" let the Chair pick from every seat
  // (there is no one to ask in the room, so "ask" picks like "auto" here)
  loadRoster();
  invalidateAdvisorCaches();
  const pick = BOARD.mode !== "default";
  const st = (s.state = { prompt: s.prompt, mode: s.mode, pick, board: pick ? SEATS.map((x) => x.key) : defaultBoard(), cards: { 1: {}, 2: {}, 3: {} }, scores: {}, rounds: [] });
  emit(s, "phase", { phase: "setup", label: "The Chair is reading your question" });
  const setup = await chairSetup(st);
  Object.assign(st, {
    title: setup.title, decision: setup.decision, brief: setup.brief,
    options: setup.options, assumptions: setup.assumptions,
    weights: Object.fromEntries(st.board.map((k) => [k, { weight: 1, reason: "" }])),
  });
  for (const w of setup.weights) if (st.weights[w.seat]) st.weights[w.seat] = { weight: Math.max(1, Math.min(3, w.weight)), reason: w.reason };
  const picked = [...new Set(setup.seats || [])].filter((k) => st.board.includes(k)).slice(0, 9);
  const full = pick && picked.length >= 3 ? picked : st.board.slice(0, 9);
  st.seats = s.mode === "quick" ? [...new Set(setup.quick_seats)].filter((k) => st.board.includes(k)).slice(0, 4) : full;
  if (s.mode === "quick" && st.seats.length < 4) {
    for (const k of full) if (st.seats.length < 4 && !st.seats.includes(k)) st.seats.push(k);
  }
  st.board = st.seats.slice(); // later Chair calls only see the seats at the table
  emit(s, "setup", { title: st.title, decision: st.decision, brief: st.brief, options: st.options, assumptions: st.assumptions, weights: st.weights, seats: st.seats, mode: s.mode });

  emit(s, "phase", { phase: "round1", label: "Round 1: opening positions" });
  st.rounds.push(1);
  await roundAll(s, st, 1, round1Prompt);

  emit(s, "phase", { phase: "cruxes", label: "The Chair is finding the fault lines" });
  const cx = await chairCruxes(st);
  st.cruxes = cx.cruxes;
  st.pressure = Object.fromEntries((cx.pressure || []).map((p) => [p.seat, p.ask]));
  emit(s, "cruxes", { cruxes: cx.cruxes, unanimous: cx.unanimous, note: cx.note, pressure: st.pressure });

  emit(s, "phase", { phase: "round2", label: "Round 2: the debate" });
  st.rounds.push(2);
  await roundAll(s, st, 2, round2Prompt);

  const s2 = st.scores[2];
  const top2 = Object.entries(s2).sort((a, b) => (b[1].score ?? 0) - (a[1].score ?? 0))[0][0];
  const vals = st.seats.map((k) => st.cards[2][k]?.parsed.optionScores[top2]).filter((v) => typeof v === "number");
  const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  const ruin = st.seats.some((k) => st.cards[2][k]?.parsed.ruin === "likely");
  const skip3 = s.mode === "quick" && spread <= 3 && !ruin;

  if (!skip3) {
    emit(s, "phase", { phase: "draft", label: "The Chair is drafting a resolution" });
    st.draft = await chairDraft(st, s2);
    emit(s, "draft", { draft: st.draft });
    emit(s, "phase", { phase: "round3", label: "Round 3: the vote" });
    st.rounds.push(3);
    await roundAll(s, st, 3, round3Prompt);
  } else {
    emit(s, "phase", { phase: "skip3", label: `Quick mode: spread ${spread} and no ruin risk, so the vote round is skipped` });
  }

  const { last, finalScores, recommended, spreadF, confidence, support, votes } = finalNumbers(st);

  emit(s, "phase", { phase: "verdict", label: "The Chair is writing the verdict" });
  const v = await chairVerdict(st, finalScores, recommended);
  st.verdict = { ...v, recommended, scores: finalScores, spread: spreadF, confidence, support, votes, disclaimer: DISCLAIMER };
  emit(s, "verdict", { verdict: st.verdict, seats: verdictSeats(st, last) });
  s.status = "done";
  emit(s, "usage", { usage: ai.usage });
  for (const res of s.subs) res.write(`data: ${JSON.stringify({ type: "end" })}\n\n`);
  save(s);
}

/** The verdict's numbers, computed from the last round's cards (shared with the folder watcher). */
export function finalNumbers(st) {
  const last = st.rounds.at(-1);
  const finalScores = st.scores[last] || optionScores(st, last);
  const recommended = Object.entries(finalScores).sort((a, b) => (b[1].score ?? 0) - (a[1].score ?? 0))[0][0];
  const fv = st.seats.map((k) => st.cards[last][k]?.parsed.optionScores[recommended]).filter((v) => typeof v === "number");
  const confs = st.seats.map((k) => st.cards[2][k]?.parsed.confidence ?? st.cards[1][k]?.parsed.confidence).filter((v) => typeof v === "number");
  const spreadF = fv.length ? Math.max(...fv) - Math.min(...fv) : 0;
  const confidence = confs.length ? Math.max(1, Math.min(10, Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 2) - (spreadF >= 5 ? 1 : 0))) : null;
  const support = last === 3 ? (() => {
    let n = 0, d = 0;
    for (const k of st.seats) { const v = st.cards[3][k]?.parsed.finalScore; if (typeof v === "number") { n += v * st.weights[k].weight; d += st.weights[k].weight; } }
    return d ? Math.round((n / d) * 10) / 10 : null;
  })() : null;
  const votes = last === 3 ? st.seats.reduce((acc, k) => { const v = st.cards[3][k]?.parsed.vote || "endorse"; acc[v] = (acc[v] || 0) + 1; return acc; }, {}) : null;
  return { last, finalScores, recommended, spreadF, confidence, support, votes };
}

export function verdictSeats(st, last) {
  return st.seats.map((k) => ({
    key: k, weight: st.weights[k].weight,
    stance: st.cards[last][k]?.parsed.vote || st.cards[2][k]?.parsed.stance,
    optionScores: st.cards[last][k]?.parsed.optionScores,
    pillar: st.cards[last][k]?.parsed.pillar ?? st.cards[2][k]?.parsed.pillar,
    moved: st.cards[2][k]?.parsed.moved,
    oneLine: st.cards[3][k]?.parsed.oneLine || st.cards[2][k]?.parsed.stance,
  }));
}

// ---------------------------------------------------------------- persistence
export function save(s) {
  try {
    const st = s.state || {};
    const dir = path.join(SESSIONS_DIR, `${s.id.slice(0, 10)}-${slugify(st.title || s.prompt)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "events.json"), JSON.stringify({ id: s.id, prompt: s.prompt, mode: s.mode, status: s.status, title: st.title, events: s.events }, null, 1));
    if (st.options) {
      const lines = [`# ${st.title}`, "", `Asked: ${s.prompt}`, "", st.brief, "", "Options:", ...st.options.map((o) => `- ${o.id}: ${o.label}`), "", "Assumptions:", ...(st.assumptions || []).map((a) => `- ${a}`), "", "| Seat | Weight | Reason |", "|---|---|---|", ...st.seats.map((k) => `| ${byKey[k].short} | ${st.weights[k].weight} | ${st.weights[k].reason} |`)];
      fs.writeFileSync(path.join(dir, "brief.md"), lines.join("\n") + "\n");
    }
    for (const r of st.rounds || []) {
      const body = (st.seats || []).map((k) => `## ${byKey[k].name} (weight ${st.weights[k].weight})\n\n${st.cards[r][k]?.text || ""}`).join("\n\n");
      fs.writeFileSync(path.join(dir, `round-${r}.md`), `# Round ${r}\n\n${body}\n`);
    }
    if (st.verdict) fs.writeFileSync(path.join(dir, "verdict.md"), verdictMarkdown(st));
    s.dir = dir;
  } catch (e) {
    console.error("save failed", e);
  }
}

function verdictMarkdown(st) {
  const v = st.verdict;
  const opt = (id) => st.options.find((o) => o.id === id)?.label || id;
  const L = [];
  L.push(`# Roast Room: ${st.title}`, "", `${new Date().toISOString().slice(0, 10)} · Seats: ${st.seats.map((k) => byKey[k].short).join(", ")} · Rounds: ${st.rounds.length} · Mode: ${st.mode}`, "");
  L.push(`## Verdict: ${v.label} (Option ${v.recommended}: ${opt(v.recommended)})`, "", `**The call:** ${v.call}`, "");
  L.push(`Option scores: ${st.options.map((o) => `${o.id} ${v.scores[o.id]?.score ?? "-"}`).join(" · ")}${v.support != null ? ` · Support for the resolution ${v.support}/10` : ""} · Confidence ${v.confidence ?? "-"}/10 · Spread ${v.spread}`);
  if (v.override_note) L.push("", v.override_note);
  L.push("", "Math: " + st.options.map((o) => `${o.id} ${v.scores[o.id]?.math} = ${v.scores[o.id]?.score}`).join(" · "));
  L.push("", "## Why the council landed here", "", ...v.why.map((w) => `- ${w.point} (${w.seat}, ${w.framework})`));
  L.push("", "## Where they fought", "", ...v.fights.map((f) => `- **${f.crux}** ${f.story}`));
  L.push("", "## Minority report", "", `${v.minority.seat}: "${v.minority.quote}" For this to be right: ${v.minority.would_have_to_be_true}`);
  if (v.amendments?.length) L.push("", "## Amendments", "", ...v.amendments.map((a) => `- ${a.seat}: ${a.amendment} ${a.adopted ? "Adopted" : "Not adopted"}: ${a.reason}`));
  L.push("", "## Conditions", "", ...v.conditions.map((c, i) => `${i + 1}. ${c}`));
  L.push("", "## What to do next", "", ...v.next_steps.map((n) => `- **${n.when}:** ${n.action}`));
  L.push("", `**Cheapest test:** ${v.cheapest_test}`, `**Kill criteria:** ${v.kill_criteria}`, `**Revisit:** ${v.revisit}`, "", "---", DISCLAIMER, "");
  return L.join("\n");
}

export function listSaved() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .map((d) => path.join(SESSIONS_DIR, d, "events.json"))
    .filter((p) => fs.existsSync(p))
    .map((p) => { const j = JSON.parse(fs.readFileSync(p, "utf8")); return { id: j.id, title: j.title || j.prompt.slice(0, 60), prompt: j.prompt, mode: j.mode, status: j.status, file: p }; })
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

export function loadSaved(id) {
  const hit = listSaved().find((x) => x.id === id);
  return hit ? JSON.parse(fs.readFileSync(hit.file, "utf8")) : null;
}
