# Roast Room

![The Roast Room](docs/room.jpg)

Bring a hard business decision and a council of AI advisors argues it out, then hands you a scored verdict and a one-click PDF. Nineteen advisors ship with it, each built from that person's public work: their letters, essays, talks, and videos. For each question, the Chair recommends who should sit on the council and you confirm. The council runs in Claude Code, and a small local web app shows them around a table talking it through. Want someone else at the table? Type `/newroaster` and a name, and Claude builds that advisor the same way.

| Seat | Pillar | The question they own |
|---|---|---|
| Jeff Bezos | Strategy and decisions | Is this the right bet, and how reversible is it? |
| Paul Graham | Product and startups | Do people actually want this, and is it growing? |
| Alex Hormozi | Offers, pricing, and sales | Will people pay, how much, and how do we close? |
| Gary Vaynerchuk | Marketing and attention | Where does the attention come from? |
| Dan Martell | People, hiring, and founder time | Who does this, and what does it cost your calendar? |
| Gino Wickman | Operations and scaling | Can the business run this without you holding it together? |
| Warren Buffett | Money and capital | What does it do to cash, risk, and long-term value? |

Those seven are the **default board**. Twelve more advisors are on call, and the Chair brings them in when your question is in their lane:

| Seat | Pillar | The question they own |
|---|---|---|
| Naval Ravikant | Leverage and wealth | Does this build leverage and equity you own, or does it just rent out your time? |
| Codie Sanchez | Buying and owning small businesses | Should you build this, or buy something that already works? |
| Leila Hormozi | Leadership and scaling teams | Can your team and your leadership carry this, and who has to change? |
| Sara Blakely | Consumer product and brand from zero | Will customers love it enough to sell it for you, without outside money? |
| Elon Musk | First principles and execution speed | What is the real constraint here, and can we cut steps and build it faster? |
| Atul Gawande | Health systems and public health | How can we improve health and care without increasing harm or waste? |
| Margaret MacMillan | History and institutions | What historical pattern or institutional context are we missing? |
| Daron Acemoglu | Economics and political economy | How will this decision affect growth, work, incentives, and prosperity over time? |
| Barbara Oakley | Education and learning | Will this help people learn, retain, and apply what it teaches? |
| Anu Bradford | EU law and digital regulation | How will law and regulation change the costs, permissions, and competitive boundaries of this decision? |
| Bruce Schneier | Technology security and privacy | Where can this technology fail, be misused, or expose people and systems? |
| Richard H. Thaler | Behavioral economics and decision-making | What biases, incentives, or friction will shape what people actually do? |

Source depth varies across the new seats; each brain's `_hot.md` records its source count, words, date range, and limits. Anu Bradford's, Bruce Schneier's, and Richard H. Thaler's seats are explicitly evidence-bounded, and unsupported topics are left unanswered.
| Atul Gawande | Health systems and public health | How can we improve health and care without increasing harm or waste? |
| Margaret MacMillan | History and institutions | What historical pattern or institutional context are we missing? |
| Daron Acemoglu | Economics and political economy | How will this decision affect growth, work, incentives, and prosperity over time? |
| Barbara Oakley | Education and learning | Will this help people learn, retain, and apply what it teaches? |
| Anu Bradford | EU law and digital regulation | How will law and regulation change the costs, permissions, and competitive boundaries of this decision? |

## What you need

- [Node.js](https://nodejs.org) 20 or newer and npm, for the room.
- [Claude Code](https://claude.com/claude-code) only for the `/roast-room` workflow that runs councils through Claude Code. That workflow does not use the room's API provider setting.
- An Anthropic or OpenAI API key only if you want the room to run councils itself (`COUNCIL_RUNNER=api`). API usage is billed by the selected provider.

## Setup

```bash
git clone https://github.com/nateherkai/roast-room.git
cd roast-room
npm install
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
- `/roast-room --all ...` seats every advisor when your roster has nine or fewer; with a larger roster, use `--seats` to name the council.
- `/roast-room board` shows who sits at the table by default and lets you change it.

The room is optional. The council runs the same in Claude Code without it.

## Choose who sits at the table

When you run `/roast-room`, the Chair reads your question and recommends a council from every advisor you have, with one line on why each one fits. You pick:

- **Recommended board**: the five to seven advisors the Chair picked for this question.
- **Default board**: your usual seven.
- **Everyone**: all of them, when you have nine or fewer.
- **Other**: type changes, like "recommended, but add Naval and drop Wickman".

A pricing question might get Hormozi, Buffett, Codie Sanchez, Sara Blakely, and Graham. A hiring question might get Leila Hormozi, Martell, Wickman, Naval, and Buffett. Every council keeps a seat that guards your downside and one that's likely to disagree, so the room argues instead of nodding.

How the board gets picked is a setting in `.claude/skills/roast-room/roster.json`:

```json
{
  "board": "ask",
  "default": ["bezos", "graham", "hormozi", "garyvee", "martell", "wickman", "buffett"],
  "seats": [ ...every advisor you have... ]
}
```

| Setting | What happens on every `/roast-room` |
|---|---|
| `"ask"` (out of the box) | The Chair recommends a council and asks you to confirm it. |
| `"auto"` | The Chair picks the council and tells you who and why, without asking. |
| `"default"` | Your default board sits every time. No question. |

You don't need to edit the file by hand. Type `/roast-room board` and say what you want: "put Naval on my default board", "take Gary V off", or "stop asking me, just use my default board".

Skip the question on any run: `--seats hormozi,buffett,oakley` seats exactly those advisors, and `--all` seats everyone when you have nine or fewer. `--quick` recommends four.

## Add your own advisor

```
/newroaster Morgan Housel
```

Claude builds a new seat the way the original seven were built:

1. **Asks two or three questions**: the business pillar and question the advisor owns (it suggests one), whether they join your default board, and how deep to go.
2. **Finds their public work**: essays, letters, talks, long interviews, and podcasts where they are the main speaker.
3. **Fetches it** into `build/<name>/`, a local folder git ignores. Web pages become text and YouTube videos become transcripts.
4. **Extracts how they think**: parallel sub-agents read every source and pull out their frameworks, rules, positions, stories, and voice, with verbatim quotes.
5. **Writes the brain** (`.claude/skills/roast-room/brains/<name>/`) and checks that every quote is word for word in the source it cites.
6. **Writes the advisor's agent** (`.claude/agents/council-<name>.md`) and adds them to `roster.json`.
7. **Makes their portrait** for the room from a real photo, in the same cartoon style as the other advisors.
8. **Tests the new seat** on a sample question, then tells you how to use it.

| Depth | Sources | Good for |
|---|---|---|
| `--quick` | 12 to 20 | Trying someone out |
| default | 30 to 50 | An advisor you'll use |
| `--deep` | 80+ | Matching the original seven |

A standard build is about 8 to 10 sub-agent runs, so it uses a real share of your plan. When it finishes, open a new Claude Code session so the advisor loads as its own agent (the council works before that too). Then use them like anyone else: `/roast-room ask housel ...`, `/roast-room --seats housel,buffett,hormozi ...`, or put them on your default board. The Chair also starts recommending them when a question fits their pillar.

You can build an advisor from public figures, living or historical, with a real body of public work, or from your own material (your posts, transcripts, notes) if you want yourself or a consenting mentor on the board. The raw sources stay on your machine; only the brain, which holds short quotes and paraphrase, is meant to be committed.

**Their face in the room:** `/newroaster` also makes the new advisor's cartoon portrait, the same way the original seven were made. It finds a real photo of the person, turns it into the same 3D cartoon style (using one of the existing cartoons as the style reference), picks the closest likeness, and makes the talking frames (mouth open, mouth "oh", and a blink). This step needs a [kie.ai](https://kie.ai/api-key) key in `.env` (`KIE_AI_API_KEY=`, about 5 image jobs per advisor) and Python with `opencv-python` (Claude installs it if it's missing). Without a key the advisor still works and shows a placeholder face; add a key later and run `/newroaster portrait <name>`.

YouTube transcripts and photos work best with [yt-dlp](https://github.com/yt-dlp/yt-dlp) installed, and PDFs need `pdftotext` ([Poppler](https://poppler.freedesktop.org)). Both are optional: without them, Claude falls back to YouTube's own captions and reads PDFs itself.

## Watch an example first

Run `npm start`, open http://localhost:4730, and click **Past sessions**. Three finished councils ship with the repo, so you can see how it works (and download their PDFs) before you run your own.

## How it works

- **The `/roast-room` workflow runs in Claude Code.** Each seat is a sub-agent (`.claude/agents/council-*.md`, listed in `roster.json`) that reads its own brain (`.claude/skills/roast-room/brains/<name>/`): frameworks, principles, positions, stories, and voice notes compiled from public sources, with every quote tied to a source. Claude Code acts as the Chair. It runs the rounds, keeps score, and writes the verdict (`.claude/skills/roast-room/SKILL.md`). The optional room API runner uses the provider selected by `LLM_PROVIDER` while sharing the council workflow and saved report format.
- **Each seat scores every option**, weighted by how much that seat's pillar matters to your decision. The Chair caps the verdict when a seat flags ruin risk, and it forces a real argument when everyone agrees too fast.
- **The viewer room watches.** As Claude Code's Chair works, it writes each step to `sessions/`, and the app plays those files back. In API mode, the room runs the same rounds and emits the same progress events itself.
- **Every council is saved** in `sessions/`. Past sessions replays any of them and downloads its PDF.
- **Claude Code usage:** a full council is three sub-agent runs per seat (21 for seven), so it takes a real bite out of your plan's usage. Use `--quick` for small calls. API mode makes separate calls for the Chair and each advisor and is billed by the selected API provider.

## Choose the API provider

The `.env` file controls only the room's API runner. The default `COUNCIL_RUNNER=viewer` plays councils created by `/roast-room` in Claude Code. Set `COUNCIL_RUNNER=api` to run the same multi-seat council directly in the room. The Chair, independent advisor calls, debate rounds, scoring, progress events, session format, and PDF report remain shared between API providers.

Copy `.env.example` to `.env` if you do not already have a `.env` file. If `.env` already exists, edit it in place; do not replace it. Keep credentials in `.env`, which is ignored by git.

```dotenv
COUNCIL_RUNNER=api
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_MODEL=claude-sonnet-5
```

Run with Claude:

```bash
npm start
```

To use OpenAI instead, set `LLM_PROVIDER=openai` and configure its API key and model. The Anthropic key is not needed for this selection:

```dotenv
COUNCIL_RUNNER=api
LLM_PROVIDER=openai
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-5.1
```

Then restart `npm start` and submit a decision in the room. To switch back, change `LLM_PROVIDER` to `anthropic`. Provider names are case-insensitive; unsupported values fail with a setup error. No provider fallback occurs. Only the selected provider's API key is required. The default models shown above are starting points; model access varies by API account, so set `ANTHROPIC_MODEL` or `OPENAI_MODEL` to a model currently available to your account if needed. Anthropic's API model list is [here](https://docs.anthropic.com/en/docs/about-claude/models/overview), and OpenAI's is [here](https://platform.openai.com/docs/models).

OpenAI API billing is separate from a ChatGPT subscription. A ChatGPT account or paid ChatGPT plan does not by itself provide API credits; see [OpenAI's billing explanation](https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform).

Common setup and API errors:

- **Missing key / authentication:** set the selected provider's key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) in `.env`, then restart the server. The other provider's key is not required.
- **Model not found or unavailable:** check the spelling and use a model enabled for that API account; update the matching `*_MODEL` setting.
- **Rate limit or quota / billing:** reduce concurrent usage and check API project limits, billing status, and available quota. The runner retries temporary rate limits a small, bounded number of times.
- **Network or service interruption:** check connectivity and retry the run. An interrupted run is reported as an error; it is not silently sent to the other provider.

OpenAI uses the Responses API with streaming text and strict JSON schema output for the Chair. Anthropic continues using its existing Messages API and structured JSON output. The Claude Code runner retains its agent tools and sub-agent workflow; those Anthropic-specific capabilities are not invoked by the OpenAI API runner. The API runner continues to call each advisor independently, with the same persona and reference material.

Run automated tests without paid API calls:

```bash
npm test
```

`npm run smoke` remains an intentional live Anthropic API smoke test and can incur charges; it is not part of `npm test`.

## What's inside

| Path | What |
|---|---|
| `.claude/skills/roast-room/` | The council skill: protocol, prompts, scoring, report template, and one brain per advisor |
| `.claude/skills/roast-room/roster.json` | Every advisor, your default board, and how the board is picked |
| `.claude/skills/newroaster/` | The `/newroaster` skill and its scripts: fetch sources, check quotes, register a seat |
| `.claude/agents/` | One agent per advisor (`council-<name>.md`) |
| `app/` | The room: a zero-dependency Node server, the web page, and the PDF builder |
| `sessions/` | Your councils (kept out of git) and the three examples |
| `build/` | Raw sources `/newroaster` fetched (kept out of git) |

## About the advisors

These are simulations built from each person's public work, and so is any advisor you add. They are not the people, they don't speak for them, and none of them is affiliated with or endorses this project. A seat only quotes a person verbatim when the line is in its brain with a source, and `python .claude/skills/roast-room/scripts/check_quotes.py sessions/<session>` checks every quote in a council against the brains. Each brain's `sources.md` lists what it was built from.

Built by AI Automation Society. The code is MIT licensed; see `LICENSE`. The PDF builder bundles [jsPDF](https://github.com/parallax/jsPDF) (MIT) and [Montserrat](https://github.com/JulietaUla/Montserrat) (SIL Open Font License); their licenses sit next to them in `app/public/`.
