# Roast Room

![The Roast Room](docs/room.jpg)

Bring a hard business decision and seven AI advisors argue it out, then hand you a scored verdict and a one-click PDF. The seats are Jeff Bezos, Paul Graham, Alex Hormozi, Gary Vaynerchuk, Dan Martell, Gino Wickman, and Warren Buffett, each built from that person's public work: their letters, essays, talks, and videos. The council runs in Claude Code, and a small local web app shows them around a table talking it through.

| Seat | Pillar | The question they own |
|---|---|---|
| Jeff Bezos | Strategy and decisions | Is this the right bet, and how reversible is it? |
| Paul Graham | Product and startups | Do people actually want this, and is it growing? |
| Alex Hormozi | Offers, pricing, and sales | Will people pay, how much, and how do we close? |
| Gary Vaynerchuk | Marketing and attention | Where does the attention come from? |
| Dan Martell | People, hiring, and founder time | Who does this, and what does it cost your calendar? |
| Gino Wickman | Operations and scaling | Can the business run this without you holding it together? |
| Warren Buffett | Money and capital | What does it do to cash, risk, and long-term value? |

## What you need

- [Claude Code](https://claude.com/claude-code). Your Claude plan covers it; no API key needed.
- [Node.js](https://nodejs.org) 20 or newer, for the room. There's nothing to install beyond that.

## Setup

```bash
git clone https://github.com/nateherkai/roast-room.git
cd roast-room
```

Or open Claude Code anywhere and say: "Clone github.com/nateherkai/roast-room and start the room for me."

## Run a roast

1. Start the room: `npm start`, then open http://localhost:4730. Leave it open.
2. Open Claude Code in the same folder: `claude`
3. Type `/roast-room` and your decision.
4. Answer the Chair's questions, then watch the council argue it out in the room.
5. When the verdict lands, click **Download PDF**.

You also get a short verdict in Claude Code, and the full report lands in `sessions/<date>-<decision>/verdict.md`.

## What to put in your question

The council is only as good as what you give it. Include:

- **The decision** in one line.
- **Your options.** Two or three. "Keep doing what I do now" counts.
- **Your numbers.** Revenue, cash, and team size.
- **Your limits.** Deadline, hours, and budget.
- **What success looks like**, and by when.
- **Which way you're leaning**, and why. The council tests your lean instead of agreeing with it.

Left something out? The Chair asks before the council starts. Example:

```
/roast-room I run a coaching business at $30k a month with 15 clients at $2,000 each.
Should I raise to $3,500 for everyone, raise for new clients only, or keep $2,000?
Close rate is about 50% and I have $40k in the bank. Success is $45k a month by March.
I'm leaning toward raising for everyone because I'm underpaid.
```

More ways to run it:

- `/roast-room --quick ...` seats four advisors for two rounds. Use it for smaller, reversible calls. It uses far less of your plan.
- `/roast-room --seats hormozi,buffett ...` seats only the advisors you name.
- `/roast-room ask hormozi ...` gets one answer from one seat.

The room is optional. The council runs the same in Claude Code without it.

## Watch an example first

Run `npm start`, open http://localhost:4730, and click **Past sessions**. Three finished councils ship with the repo, so you can see how it works (and download their PDFs) before you run your own.

## How it works

- **The council runs in Claude Code.** Each seat is a sub-agent (`.claude/agents/council-*.md`) that reads its own brain (`.claude/skills/roast-room/brains/<name>/`): frameworks, principles, positions, stories, and voice notes compiled from public sources, with every quote tied to a source. Claude Code acts as the Chair. It runs the rounds, keeps score, and writes the verdict (`.claude/skills/roast-room/SKILL.md`).
- **Each seat scores every option**, weighted by how much that seat's pillar matters to your decision. The Chair caps the verdict when a seat flags ruin risk, and it forces a real argument when everyone agrees too fast.
- **The room watches session files.** In the original Claude Code/viewer flow it makes no AI calls itself. In `hybrid` or `api` mode, the composer can launch the selected runner, which still writes the same files to `sessions/` for the room to play back.
- **Every council is saved** in `sessions/`. Past sessions replays any of them and downloads its PDF.
- **Usage:** a full council is 21 sub-agent runs, so it takes a real bite out of your plan's usage. Use `--quick` for small calls.

## Hybrid local runner

This checkout also includes `hybrid/`, which lets you type a decision directly into the room without an Anthropic API key. Set `COUNCIL_RUNNER=hybrid`: the seven advisor seats run through the authenticated Gemini CLI, while setup, cruxes, and the final Chair verdict run through the authenticated GitHub Copilot CLI. If Copilot is unavailable, the Chair can fall back to Gemini. The runner writes the same `sessions/` files, so the existing live room, replay, and PDF flow stay unchanged.

On this 8 GB machine the tested settings are `GEMINI_MODEL=gemini-2.5-flash` and `GEMINI_CONCURRENCY=1`. The hybrid runner loads `.env` automatically and checkpoints each completed round card so interrupted councils can resume with `npm run hybrid:resume -- SESSION_ID` instead of rerunning completed work. In Hybrid mode, resumable sessions also get a **Resume** button in **Past sessions**; active Hybrid sessions show saved progress and a **Stop council** control that preserves checkpoints for later Resume. Unexpected Hybrid runner failures are persisted and shown in session history instead of disappearing as an unexplained stop.

Hybrid reliability metadata is stored in each session's `hybrid-meta.json` without prompt or model-output text. The room surfaces runtime, provider-call, retry, and Chair-fallback counts. Advisor retries default to one retry for transient network/rate-limit failures only; set `GEMINI_SEAT_RETRIES=0..2` and `GEMINI_RETRY_BASE_MS=250..30000` to tune or disable them. See `hybrid/README.md` for the terminal commands and architecture.

## Back up local councils

Your personal `sessions/` are intentionally kept out of Git, so use the Windows backup helper when you want an offline recovery point:

`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup-roast-room.ps1`

It creates an ignored `backups/roast-room-<timestamp>/` folder with a verified `repo.bundle`, `sessions.zip`, a manifest, and restore instructions. `.env` is excluded by default so local credentials are not copied. Add `-IncludeEnv` only when you intentionally want the local configuration included in that backup.

## Optional: Anthropic API runner

If you'd rather use the original API runner, copy `.env.example` to `.env`, add an `ANTHROPIC_API_KEY`, set `COUNCIL_RUNNER=api`, and restart `npm start`. That mode bills your Anthropic API account (about 25 calls per full council).

## What's inside

| Path | What |
|---|---|
| `.claude/skills/roast-room/` | The skill: protocol, prompts, scoring, report template, and the seven brains |
| `.claude/agents/` | The seven seat agents |
| `app/` | The room: a zero-dependency Node server, the web page, and the PDF builder |
| `hybrid/` | Gemini-seat + Copilot-Chair local runner and its JSON schemas |
| `sessions/` | Your councils (kept out of git) and the three examples |

## About the advisors

These are simulations built from each person's public work. They are not the people, they don't speak for them, and none of them is affiliated with or endorses this project. A seat only quotes a person verbatim when the line is in its brain with a source, and `python .claude/skills/roast-room/scripts/check_quotes.py sessions/<session>` checks every quote in a council against the brains. Each brain's `sources.md` lists what it was built from.

Built by AI Automation Society. The code is MIT licensed; see `LICENSE`. The PDF builder bundles [jsPDF](https://github.com/parallax/jsPDF) (MIT) and [Montserrat](https://github.com/JulietaUla/Montserrat) (SIL Open Font License); their licenses sit next to them in `app/public/`.
