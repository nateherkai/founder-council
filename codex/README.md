# Codex text-only skill

Install from a local checkout using Python 3 and Git:

```sh
python3 scripts/install_codex.py
```

The default destination is `~/.agents/skills/roast-room`, the user skill directory
in the [official Codex documentation](https://learn.chatgpt.com/docs/build-skills).
`CODEX_HOME` configures Codex state; it does not change this user discovery path.
To use a different location:

```sh
python3 scripts/install_codex.py --dest /path/to/skills/roast-room
```

The destination must not exist. The installer copies the shared brains,
references, quote checker, license, and a Codex-specific entrypoint. It adapts
seat instructions to the installed resource paths and writes `SOURCE.json` with
the source commit and file inventory. It does not modify the Claude Code skill,
global instructions, permissions, credentials, or shell configuration. It installs
no npm packages and starts no services.

Codex detects skill changes automatically. If it does not appear, restart Codex
when convenient. Invoke it explicitly:

```text
$roast-room ask hormozi How should a fictional service business test a price increase?
$roast-room --quick Compare hiring a salesperson with keeping founder-led sales.
```

The skill description also permits automatic selection for business-management
help. Users who want an explicit global preference may add this to their existing
`~/.codex/AGENTS.md`, preserving all other instructions:

```text
For business-management help, use the roast-room skill. Use a focused consult for
simple questions and a council for consequential decisions.
```

Consults require one seat response; a full council uses 21 and can consume
substantial model usage. Codex uses its available delegation tools, subject to
runtime limits, or discloses a sequential single-model simulation. Responses use
the user's language. No separate Anthropic key is required by the skill.

Chat-only use does not write session files. Request an output directory to save a
council. The installed skill is independent of the active project's directory.
The optional web viewer and its PDF export remain separate: to use them, request
output in this checkout's `sessions/` directory and start the viewer separately
using the main README. The skill does not automatically start it or enable API mode.

The quote checker checks matching text in the bundled corpus; it does not prove
the claimed author or source ID. Verify attributed quotations against the relevant
seat and source entry. The seats are simulations, not endorsements or actual
statements by those people. Session reports can contain confidential information;
keep them out of public commits.

Run the packaging tests offline, without installing dependencies:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

Tests install into temporary directories, check the default discovery directory,
explicit destinations, resource paths and overwrite
protection, and run the quote checker on a fabricated quote from an unrelated
working directory. They do not evaluate model reasoning or run the web app.

For a previous installation under `~/.codex/skills/roast-room`, preserve that
directory and add a symlink at `~/.agents/skills/roast-room` pointing to it if the
latter path does not exist. Codex supports symlinked skill folders. The installer
does not create this link or relocate existing installations automatically.
