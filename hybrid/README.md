# Hybrid Roast Room

This local extension keeps the original Claude Code flow intact and adds a provider-independent runner.

- **Advisor seats:** Gemini CLI, read-only (`--approval-mode plan`)
- **Chair / cruxes / draft / verdict:** GitHub Copilot Student CLI in plan mode
- **Chair fallback:** Gemini CLI if Copilot is unavailable or returns unusable JSON
- **UI / PDF / sessions:** the original Roast Room app
- **API keys:** none are stored by this runner; it reuses the existing authenticated CLI sessions.

## Start

`npm start`

Open <http://localhost:4730>. With `COUNCIL_RUNNER=hybrid`, the composer is enabled. Enter a decision, choose Full or Quick, and convene the council.

## Terminal alternative

Full council:

`npm run hybrid -- "your decision and context"`

Quick council:

`npm run hybrid:quick -- "your decision and context"`

Resume an interrupted hybrid session without rerunning completed seats or Chair stages:

`npm run hybrid:resume -- SESSION_ID`

In Hybrid mode, interrupted Hybrid sessions also show a **Resume** button in **Past sessions**, so the same recovery path can be started from the room UI. While a Hybrid council is running, the room shows its saved progress (for example `Openings 2/4`) and a **Stop council** control. Stop terminates the Hybrid process tree but keeps completed checkpoints, so the same session can be resumed later without rerunning saved seats. Unexpected runner failures are saved to `hybrid-error.json`, surfaced live in the room, and remain visible in session history until the next Resume attempt.

Provider timing and reliability metadata are saved to `hybrid-meta.json`; prompts and model-output text are not copied into telemetry. Active and past sessions show runtime, provider-call, retry, and Chair-fallback counts in the room.

The runner loads `.env` itself before it resolves providers, models, concurrency, and retry policy. Explicit process environment variables still take precedence. Each completed seat card is checkpointed to `round-N.json`, and older interrupted sessions that only have `round-N.md` are reconstructed automatically when possible. `GEMINI_SEAT_RETRIES` defaults to `1` (range `0..2`) and retries only transient network/rate-limit failures. `GEMINI_RETRY_BASE_MS` defaults to `1500` ms (range `250..30000`) and uses capped exponential backoff.

## Architecture and safety

The Node runner loads the original Roast Room agent instructions and brain files and places that reference material directly in each Gemini seat prompt. Gemini runs in read-only plan mode; it does not write the session files. The Copilot Chair runs in an isolated empty working directory with custom instructions and built-in MCP servers disabled and remote control disabled. The Node runner is the only component that writes session artifacts.

Session artifacts use the original `sessions/` format, so the existing live room and PDF renderer continue to work. On this 8 GB machine the local `.env` is configured with `GEMINI_CONCURRENCY=1` and `GEMINI_MODEL=gemini-2.5-flash`; this avoids RAM spikes and was materially faster than the CLI default in the integration test.

For testing or if Copilot is unavailable, set `CHAIR_PROVIDER=gemini`. The original Claude Code `/roast-room` skill and Anthropic API runner were not removed.
