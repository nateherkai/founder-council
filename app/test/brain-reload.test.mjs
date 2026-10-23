import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGINAL_QUOTE = "Original brain quote contains enough words to verify";
const UPDATED_QUOTE = "Updated brain quote contains enough words to verify";

function makeFixture(t) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "roast-room-brain-reload-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const lib = path.join(fixture, "app", "lib");
  const agents = path.join(fixture, ".claude", "agents");
  const skill = path.join(fixture, ".claude", "skills", "roast-room");
  const brain = path.join(skill, "brains", "test-advisor");
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(agents, { recursive: true });
  fs.mkdirSync(brain, { recursive: true });

  fs.copyFileSync(path.join(ROOT, "app", "lib", "env.mjs"), path.join(lib, "env.mjs"));
  fs.copyFileSync(path.join(ROOT, "app", "lib", "seats.mjs"), path.join(lib, "seats.mjs"));
  fs.writeFileSync(path.join(agents, "council-test.md"), "---\nname: test\n---\nTest agent\n");
  fs.writeFileSync(path.join(skill, "roster.json"), JSON.stringify({
    seats: [{
      key: "test",
      slug: "test-advisor",
      name: "Test Advisor",
      short: "Test",
      pillar: "Testing",
      question: "Does it reload?",
      dimension: "Freshness",
    }],
  }));

  return { fixture, lib, skill, brain };
}

async function waitForCouncil(session) {
  for (let i = 0; i < 100 && session.status === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.notEqual(session.status, "running", "council did not finish");
  assert.equal(session.status, "done");
}

test("systemFor reloads an existing advisor when a brain file changes", async (t) => {
  const { lib, skill, brain } = makeFixture(t);
  fs.writeFileSync(path.join(brain, "_hot.md"), `ORIGINAL_BRAIN\n"${ORIGINAL_QUOTE}" (S001)\n`);

  const seats = await import(pathToFileURL(path.join(lib, "seats.mjs")));
  const before = seats.systemFor("test")[0].text;
  assert.match(before, /ORIGINAL_BRAIN/);
  assert.equal(seats.checkQuotes("test", `"${ORIGINAL_QUOTE}" (S001)`)[0]?.verified, true);

  fs.writeFileSync(path.join(brain, "_hot.md"), `UPDATED_BRAIN\n"${UPDATED_QUOTE}" (S002)\n`);
  assert.match(fs.readFileSync(path.join(brain, "_hot.md"), "utf8"), /UPDATED_BRAIN/);

  // This is the same refresh boundary used by app/lib/council.mjs before a new
  // API-runner council. The next system prompt must include the edited brain.
  seats.loadRoster();
  seats.invalidateAdvisorCaches();
  const afterSystem = seats.systemFor("test");
  const after = afterSystem[0].text;

  assert.match(after, /UPDATED_BRAIN/);
  assert.doesNotMatch(after, /ORIGINAL_BRAIN/);
  assert.equal(seats.checkQuotes("test", `"${UPDATED_QUOTE}" (S002)`)[0]?.verified, true);
  assert.equal(seats.checkQuotes("test", `"${ORIGINAL_QUOTE}" (S001)`)[0]?.verified, false);

  // Repeated accesses during this council keep using the prompt and quote corpus
  // that were loaded at its boundary.
  assert.strictEqual(seats.systemFor("test"), afterSystem);
  fs.writeFileSync(path.join(brain, "_hot.md"), `LATER_BRAIN\n"A later brain quote also has enough words" (S003)\n`);
  assert.equal(seats.checkQuotes("test", `"${UPDATED_QUOTE}" (S002)`)[0]?.verified, true);
  assert.equal(seats.checkQuotes("test", '"A later brain quote also has enough words" (S003)')[0]?.verified, false);
});

test("a second API-runner council loads edited brain content without a restart", async (t) => {
  const { lib, brain } = makeFixture(t);
  fs.copyFileSync(path.join(ROOT, "app", "lib", "council.mjs"), path.join(lib, "council.mjs"));
  fs.writeFileSync(path.join(lib, "anthropic.mjs"), `
export const systems = [];
export const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
export const S = {
  str: { type: "string" }, num: { type: "number" }, int: { type: "integer" }, bool: { type: "boolean" },
  arr: (items) => ({ type: "array", items }),
  obj: (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false }),
  enum: (...values) => ({ type: "string", enum: values }),
};
export async function json({ schema }) {
  if (schema.properties.title) return {
    title: "Cache test", decision: "Test the cache", brief: "Fixture", options: [{ id: "A", label: "Change" }, { id: "B", label: "Wait" }],
    assumptions: [], weights: [{ seat: "test", weight: 3, reason: "Testing" }], quick_seats: ["test"], seats: ["test"],
  };
  if (schema.properties.cruxes) return { cruxes: [], unanimous: true, note: "", pressure: [] };
  if (schema.properties.call) return {
    label: "GO", call: "Choose A.", override_note: "", why: [], fights: [],
    minority: { seat: "Test", quote: "None", would_have_to_be_true: "" }, amendments: [], conditions: [],
    next_steps: [], cheapest_test: "", kill_criteria: "", revisit: "",
  };
  throw new Error("unexpected structured call");
}
export async function stream({ system }) {
  systems.push(system);
  const updated = system[0].text.includes("SECOND_COUNCIL_BRAIN");
  const quote = updated ? "${UPDATED_QUOTE}" : "${ORIGINAL_QUOTE}";
  const source = updated ? "S002" : "S001";
  return "SEAT: TEST\\nSTANCE: Yes\\nOPTION SCORES: A 8/10 · B 4/10\\nPILLAR SCORE: 8/10\\nCONFIDENCE: 4/5\\nRUIN RISK: none\\nDOOR: two-way\\nTHE CALL: Choose A.\\nWHY:\\n1. \\\"" + quote + "\\\" (" + source + ")";
}
`);
  fs.writeFileSync(path.join(brain, "_hot.md"), `FIRST_COUNCIL_BRAIN\n"${ORIGINAL_QUOTE}" (S001)\n`);

  const council = await import(pathToFileURL(path.join(lib, "council.mjs")));
  const anthropic = await import(pathToFileURL(path.join(lib, "anthropic.mjs")));

  const first = council.startCouncil("First council prompt", "quick");
  await waitForCouncil(first);
  assert.equal(anthropic.systems.length, 2);
  assert.ok(anthropic.systems.slice(0, 2).every((system) => system[0].text.includes("FIRST_COUNCIL_BRAIN")));
  assert.ok(first.events.filter((event) => event.type === "seat_done").every((event) => event.quotes[0]?.verified));

  fs.writeFileSync(path.join(brain, "_hot.md"), `SECOND_COUNCIL_BRAIN\n"${UPDATED_QUOTE}" (S002)\n`);
  const second = council.startCouncil("Second council prompt", "quick");
  await waitForCouncil(second);

  assert.equal(anthropic.systems.length, 4);
  assert.ok(anthropic.systems.slice(2).every((system) => system[0].text.includes("SECOND_COUNCIL_BRAIN")));
  assert.ok(anthropic.systems.slice(2).every((system) => !system[0].text.includes("FIRST_COUNCIL_BRAIN")));
  assert.ok(second.events.filter((event) => event.type === "seat_done").every((event) => event.quotes[0]?.verified));
});
