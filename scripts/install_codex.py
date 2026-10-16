#!/usr/bin/env python3
"""Install the text-only Codex skill from a local Roast Room checkout."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess


REPO = Path(__file__).resolve().parents[1]
SOURCE_SKILL = REPO / ".claude" / "skills" / "roast-room"


def install(destination):
    destination = Path(destination).expanduser().absolute()
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(f"Destination already exists: {destination}")

    # Check every input before creating the destination. Never copy Claude's
    # permissions, launch configuration, app, .env, or saved councils.
    inputs = [REPO / "codex" / "SKILL.md", REPO / "LICENSE"]
    inputs += sorted((REPO / ".claude" / "agents").glob("council-*.md"))
    inputs += [SOURCE_SKILL / name for name in ("brains", "references", "scripts")]
    if len(list((REPO / ".claude" / "agents").glob("council-*.md"))) != 7:
        raise ValueError("Expected seven council seat files")
    for source in inputs:
        if not source.exists():
            raise FileNotFoundError(source)

    destination.mkdir(parents=True)
    try:
        shutil.copy2(REPO / "codex" / "SKILL.md", destination / "SKILL.md")
        shutil.copy2(REPO / "LICENSE", destination / "LICENSE")
        for name in ("brains", "references", "scripts"):
            shutil.copytree(SOURCE_SKILL / name, destination / name)

        agents = destination / "references" / "agents"
        agents.mkdir()
        for source in sorted((REPO / ".claude" / "agents").glob("council-*.md")):
            text = source.read_text(encoding="utf-8")
            # Claude's agent frontmatter is not a Codex agent registration.
            if not text.startswith("---\n") or "\n---\n" not in text[4:]:
                raise ValueError(f"Missing agent frontmatter: {source}")
            text = text.split("\n---\n", 1)[1].lstrip("\n")
            text = text.replace(".claude/skills/roast-room/", destination.as_posix() + "/")
            (agents / source.name).write_text(text, encoding="utf-8")

        prompts = destination / "references" / "round-prompts.md"
        text = prompts.read_text(encoding="utf-8")
        start = text.index("Agent type:")
        end = text.index("**Options.**", start)
        text = text[:start] + (
            "Use the available Codex delegation tools when permitted, or run the seats "
            "sequentially. Read the seat instructions in `references/agents/` relative "
            "to the installed skill. Give each seat the absolute skill root and session "
            "directory, or supply the brief and prior cards directly when using chat only. "
            "Seat agents only read resources and return cards.\n\n"
        ) + text[end:]
        text = text.replace("then at most four more brain files", "then at most three more brain files")
        prompts.write_text(text, encoding="utf-8")

        seats = destination / "references" / "seats.md"
        text = seats.read_text(encoding="utf-8").replace(
            "`.claude/skills/roast-room/`", "the installed skill directory"
        )
        seats.write_text(text, encoding="utf-8")
        report = destination / "references" / "report-template.md"
        text = report.read_text(encoding="utf-8").replace(
            "Written by the Chair in plain English.",
            "Written by the Chair in plain language, using the user's language.",
        )
        report.write_text(text, encoding="utf-8")

        # The checker resolves brains relative to its own location already.
        checker = destination / "scripts" / "check_quotes.py"
        text = checker.read_text(encoding="utf-8").replace(
            ".claude/skills/roast-room/scripts/check_quotes.py",
            "<SKILL_ROOT>/scripts/check_quotes.py",
        )
        checker.write_text(text, encoding="utf-8")
        commit = subprocess.run(
            ["git", "-C", str(REPO), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        manifest = {
            "source": "https://github.com/nateherkai/roast-room",
            "commit": commit,
            "layout": "codex-text-only",
            "files": sorted(p.relative_to(destination).as_posix()
                            for p in destination.rglob("*") if p.is_file()),
            "adaptations": ["Codex entrypoint", "skill-relative resources",
                            "seat instructions as references", "optional persistence and viewer"],
        }
        (destination / "SOURCE.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )
    except BaseException:
        shutil.rmtree(destination)
        raise
    return destination


def default_destination():
    return Path.home() / ".agents" / "skills" / "roast-room"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", type=Path, default=default_destination(),
                        help="Exact skill directory; must not already exist")
    args = parser.parse_args()
    try:
        destination = install(args.dest)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Installation failed: {error}\n")
    print(f"Installed text-only Roast Room skill: {destination}")
    print("The skill is available on your next turn. Invoke it with $roast-room.")
    print("No global instructions, dependencies, credentials, or services were changed.")


if __name__ == "__main__":
    main()
