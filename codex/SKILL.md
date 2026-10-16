---
name: roast-room
description: Help with business management and founder decisions using grounded advisor simulations. Use for strategy, pricing, sales, hiring, delegation, operations, cash allocation, partnerships, fundraising, or an explicit Roast Room council or single-seat consult.
---

# Roast Room for Codex

Seven simulated advisors debate a business decision; the Chair weighs arguments,
checks the arithmetic, and returns a recommendation, dissent, and next steps.
These are simulations based on public work, not the real people or their advice.
Reply in the user's language. Separate known facts from assumptions.

## Installed resources

Resolve resource paths from this installed `SKILL.md`, not the current project.
Call that absolute directory **SKILL_ROOT**. Brains live in `brains/<slug>/`,
and seat instructions in `references/agents/council-<seat>.md`.

Read `references/seats.md` for seats and weights. For a scored council, also read
`references/round-prompts.md`, `references/scoring.md`, and
`references/report-template.md`. These are shared with the Claude Code skill.

## Choose the scope

- **Consult:** one relevant seat for a simple question; no scoring or session files.
- **Quick council:** four relevant seats, two rounds. Run ratification only when
  the Round 2 spread on the leading option exceeds 3 or a seat flags likely ruin.
- **Full council:** seven seats and three rounds for expensive or hard-to-reverse
  decisions, or when the user asks for the full council.
- **Named seats:** use only the requested seats.

Honor the user's choice. For ordinary management help, use the smallest mode that
answers the question. A full council means 21 seat responses and substantial model
usage; name the mode before beginning. No API key, Node server, or npm is needed
for this text workflow.

## Brief

Establish the decision and options (including keeping the status quo), business
and audience, resources and deadline, success measure and horizon, and the
founder's current preference. Use context the user has supplied or authorized;
do not search unrelated projects or credentials. Ask for missing facts that
materially change the recommendation in one concise batch, or proceed with
explicit assumptions when the user asks. Keep the brief under 300 words.

## Consult

Read that seat's instructions, `_hot.md`, and the relevant brain files within the
limits in the seat instructions. Use the single-seat prompt in
`references/round-prompts.md`. Give the call, source-grounded reasoning, a next
action, and any material uncertainty. Label the voice as a simulation.

## Council

1. Assign each seat a relevance weight of 1 to 3, with a reason.
2. Run Round 1 openings using the shared round prompts. Check all required fields
   and option scores. Identify one to three cruxes. Apply the unanimity check.
3. Run Round 2 with the brief, prior cards, and cruxes. Preserve the seat cards;
   explain who changed position and why.
4. Draft a resolution: named option, conditions, owners and dates where known,
   cheapest test, and kill criteria. Apply the scoring overrides.
5. Run Round 3 ratification when the mode requires it, adopt justified amendments,
   and preserve the strongest dissent. Do not add a fourth round.
6. Calculate weighted scores from the last round using `references/scoring.md`.
   Show the arithmetic; scores are judgments, not statistical probabilities.
7. Verify attributed quotations against the appropriate seat's brain and source
   entry. The bundled checker only finds matching text in the combined corpus;
   it does not authenticate a quote's author or source ID. Remove unverifiable
   quotes rather than attributing them to the real person.
8. Return a short verdict: recommendation, option scores, decisive arguments,
   strongest objection, and at most three next actions. Provide the full report
   when requested, using `references/report-template.md`.

When delegation is available and permitted, give each agent its seat instructions,
the absolute SKILL_ROOT and the minimum brief/previous cards needed for that round.
Use the runtime's actual agent tools, respect its concurrency limit, and limit
seat agents to reading their resources and returning cards. Do not assume Claude
agent types or tools exist. Without delegation, perform the same rounds
sequentially and disclose that the perspectives came from one model; do not claim
independent agents. Keep Round 1 openings independent of prior openings as far as
the runtime allows.

## Files and optional viewer

Keep the brief and cards in the conversation by default. Create persistent files
only when the user requests them, in their chosen output directory, outside the
installed skill. Pass brief/cards directly to agents when there are no files;
replace file-reading lines in the shared prompts accordingly.

For a saved council, write `brief.md`, `round-1.md`, `round-2.md`, the draft,
`round-3.md` if applicable, and `verdict.md`. The optional local check is:

```sh
python3 "<SKILL_ROOT>/scripts/check_quotes.py" "<session-directory>"
```

If Python is unavailable, verify quotes manually. No installation is required.

The separate web viewer is not installed with this skill. Only read
`references/live-room.md` and emit its JSON files when the user requests viewer
integration with a checkout's `sessions/` directory. Do not start a server,
configure API services, advertise a live URL, or promise a PDF unless that viewer
has actually been started at the user's request. A saved council may contain
confidential information; do not publish or send it to external services.
