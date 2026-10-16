"""Offline packaging tests. No model, network, npm, or server is used."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("install_codex", REPO / "scripts/install_codex.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class CodexInstallTests(unittest.TestCase):
    def test_skill_is_portable_and_checker_finds_its_brains(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            skill = installer.install(root / "skills with spaces" / "roast-room")
            manifest = json.loads((skill / "SOURCE.json").read_text())
            self.assertEqual(len(list((skill / "brains").glob("*/*.md"))), 56)
            seats = sorted((skill / "references/agents").glob("council-*.md"))
            self.assertEqual(len(seats), 7)
            for seat in seats:
                text = seat.read_text()
                self.assertNotIn(".claude/", text)
                self.assertNotIn("maxTurns:", text)
                self.assertIn(skill.as_posix() + "/brains/", text)
            self.assertTrue(all((skill / name).is_file() for name in manifest["files"]))
            self.assertFalse((skill / "app").exists())
            self.assertFalse((skill / ".env").exists())
            self.assertFalse((skill / "sessions").exists())
            self.assertNotIn("subagent_type", (skill / "SKILL.md").read_text())
            self.assertNotIn(".claude/", (skill / "references/seats.md").read_text())
            self.assertIn("user's language", (skill / "references/report-template.md").read_text())
            self.assertNotIn("at most four more", (skill / "references/round-prompts.md").read_text())

            session = root / "fictional-session"
            session.mkdir()
            (session / "round-1.md").write_text(
                '# Fictional test\n"This fabricated quotation should never pass verification" (S999)\n'
            )
            result = subprocess.run(
                [sys.executable, str(skill / "scripts/check_quotes.py"), str(session)],
                cwd=root, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("unverified: 1", result.stdout)

    def test_existing_destination_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            skill = Path(temporary) / "existing"
            skill.mkdir()
            sentinel = skill / "SKILL.md"
            sentinel.write_text("Existing user content\n")
            with self.assertRaises(FileExistsError):
                installer.install(skill)
            self.assertEqual(sentinel.read_text(), "Existing user content\n")

    def test_default_uses_user_discovery_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                self.assertEqual(installer.default_destination(),
                                 Path(temporary) / ".agents/skills/roast-room")

    def test_cli_honors_explicit_destination(self):
        import os
        with tempfile.TemporaryDirectory() as temporary:
            env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
            destination = Path(temporary) / "custom-skill"
            result = subprocess.run(
                [sys.executable, str(REPO / "scripts/install_codex.py"), "--dest", str(destination)],
                env=env, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((destination / "SKILL.md").is_file())


if __name__ == "__main__":
    unittest.main()
