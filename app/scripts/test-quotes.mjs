// Quote check tests: node --test app/scripts/test-quotes.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { checkQuotes } from "../lib/seats.mjs";

const one = (key, text) => checkQuotes(key, text).map(({ quote, source, verified }) => [quote, source, verified]);
const STICK = "Stick with big, 'easy' decisions and eschew activity.";

test("nested single and double quotes verify", () => {
  assert.deepEqual(one("buffett", `"${STICK}" (S090)`), [[STICK, "S090", true]]);
  const dbl = 'Stick with big, "easy" decisions and eschew activity.';
  assert.deepEqual(one("buffett", `He said: "${dbl}" (S090)`), [[dbl, "S090", true]]);
});

test("labelled source ids are read", () => {
  const r = one("buffett", `"We can afford to lose money but we can't afford to lose reputation." (Reputation, S028)`);
  assert.deepEqual(r.map((x) => x[1]), ["S028"]);
});

test("invented quotes are flagged, after a dash or comma too", () => {
  for (const lead of ["", "Graham—", "He said,"]) {
    const r = one("graham", `${lead}"Always raise the biggest round you possibly can get." (S011)`);
    assert.deepEqual(r, [["Always raise the biggest round you possibly can get.", "S011", false]], lead);
  }
});

test("an earlier separate quote stays out; an invented lead-in stays in", () => {
  const sep = one("buffett", `Buyers ask "which tool for my business," and that matters. "${STICK}" (S090)`);
  assert.deepEqual(sep, [[STICK, "S090", true]]);
  const lead = one("buffett", `"Totally invented opening words here. "${STICK}" (S090)`);
  assert.equal(lead[0][2], false);
});

test("a quote shortened with an ellipsis verifies; pieces out of order do not", () => {
  const short = "The biggest mistakes... they're the mistakes of omission rather than commission";
  assert.equal(one("buffett", `"${short}" (S028)`)[0][2], true);
  const swapped = "the mistakes of omission rather than commission... The biggest mistakes";
  assert.equal(one("buffett", `"${swapped}" (S028)`)[0][2], false);
  const changed = "The biggest mistakes... are the mistakes of omission rather than commission";
  assert.equal(one("buffett", `"${changed}" (S028)`)[0][2], false);
  assert.equal(one("buffett", `"The ... of ... the ... is ... a" (S028)`)[0]?.[2] ?? false, false);
  assert.equal(one("buffett", `"we always the ... the ... and ... to ... of the" (S028)`)[0][2], false);
});

test("a quote of the brief or an earlier round is marked context, not invented", () => {
  const founder = "competitors with funding will outspend us, so we raise now";
  const r = checkQuotes("buffett", `"${founder}" (S031)`, `Founder's lean: "${founder}".`);
  assert.equal(r[0].verified, false);
  assert.equal(r[0].context, true);
  assert.equal(checkQuotes("buffett", `"${founder}" (S031)`)[0].context, false);
  assert.equal(checkQuotes("buffett", `"${STICK}" (S090)`, STICK)[0].context, false);
});

test("a real line under the wrong source id is flagged with the right id", () => {
  const r = checkQuotes("buffett", `"${STICK}" (S028)`)[0];
  assert.equal(r.verified, false);
  assert.deepEqual(r.citedAs, ["S090"]);
  assert.equal(checkQuotes("buffett", `"${STICK}" (S090)`)[0].citedAs, null);
  for (const cite of ["(S090, S028)", "(S028, S090)", "[S090; S028]", "(S028 and S090)"]) {
    assert.equal(checkQuotes("buffett", `"${STICK}" ${cite}`)[0].verified, true, cite);
  }
});
