"""Tests for check_quotes.py. Run: python3 -m unittest .claude/skills/roast-room/scripts/test_check_quotes.py"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_quotes  # noqa: E402

BRAIN = """
- "Stick with big, “easy” decisions and eschew activity." (S090)
- filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler - filler 
- "We can afford to lose money but we can't afford to lose reputation." (S028)
- "Make something people want, and the rest mostly follows from that." (S092)
- "An entry that carries no source id at all in the brain."
- "the biggest mistakes are the ones that actually don't show up they're the mistakes of omission rather than commission" (S028)
"""


class CheckQuotesTest(unittest.TestCase):
    def run_check(self, rounds, brief=""):
        with tempfile.TemporaryDirectory() as tmp:
            brains = Path(tmp, "brains", "seat")
            brains.mkdir(parents=True)
            (brains / "principles.md").write_text(BRAIN, encoding="utf-8")
            session = Path(tmp, "session")
            session.mkdir()
            (session / "brief.md").write_text(brief, encoding="utf-8")
            for i, text in enumerate(rounds, 1):
                (session / f"round-{i}.md").write_text(text, encoding="utf-8")
            return check_quotes.check(session, brains.parent)

    def test_nested_straight_double_quotes(self):
        ok, _, bad = self.run_check(['He said: "Stick with big, "easy" decisions and eschew activity." (S090)'])
        self.assertEqual((ok, bad), (1, []))

    def test_nested_single_quotes(self):
        ok, _, bad = self.run_check(["\"Stick with big, 'easy' decisions and eschew activity.\" (S090)"])
        self.assertEqual((ok, bad), (1, []))

    def test_apostrophe_inside_word_and_curly_quotes(self):
        ok, _, bad = self.run_check(["“We can afford to lose money but we can’t afford to lose reputation.” (S028)"])
        self.assertEqual((ok, bad), (1, []))

    def test_bracket_attribution(self):
        ok, _, bad = self.run_check(['"Make something people want, and the rest mostly follows" [S092, 2005]'])
        self.assertEqual((ok, bad), (1, []))

    def test_unattributed_quote_before_attributed_one(self):
        ok, _, bad = self.run_check(
            ['The founder said "this is a note with no source id" and then "Make something people want, and the rest mostly follows from that." (S092)']
        )
        self.assertEqual((ok, bad), (1, []))

    def test_invented_quote_is_flagged(self):
        ok, _, bad = self.run_check(['"Always raise the biggest round you possibly can get." (S011)'])
        self.assertEqual(ok, 0)
        self.assertEqual(bad, [("round-1.md", "Always raise the biggest round you possibly can get.", "not in a brain")])

    def test_quote_of_earlier_round_is_internal(self):
        r1 = "Graham: speed beats everything when you have no users at all yet."
        r2 = '"speed beats everything when you have no users at all yet" (S100)'
        ok, internal, bad = self.run_check([r1, r2])
        self.assertEqual((ok, internal, bad), (0, 1, []))

    def test_short_attributed_quote_after_another_quote_is_skipped(self):
        ok, internal, bad = self.run_check(
            ['They pitch "alongside" HubSpot, so the offer is not sharp at all. "Quantity is not debatable" [S038, 2026]']
        )
        self.assertEqual((ok, internal, bad), (0, 0, []))

    def test_quote_after_dash_or_comma_is_checked(self):
        for lead in ["Graham—", "He said,"]:
            _, _, bad = self.run_check([lead + '"Always raise the biggest round you possibly can get." (S011)'])
            self.assertEqual(len(bad), 1, lead)

    def test_invented_lead_in_before_nested_real_quote_is_flagged(self):
        _, _, bad = self.run_check(
            ['"Totally invented opening words that are not real. "Make something people want, and the rest mostly follows from that." (S092)']
        )
        self.assertEqual(len(bad), 1)

    def test_nested_quote_report_shows_whole_quote(self):
        _, _, bad = self.run_check(['"Stick with big, "easy" decisions and invented stuff after it." (S090)'])
        self.assertEqual(bad, [("round-1.md", 'Stick with big, "easy" decisions and invented stuff after it.', "not in a brain")])

    def test_labelled_source_id(self):
        ok, _, bad = self.run_check(['A lead magnet is "Make something people want, and the rest mostly follows from that." (Essays, S092) D is built on it, "and this" too.'])
        self.assertEqual((ok, bad), (1, []))

    def test_earlier_quote_ending_in_comma(self):
        ok, _, bad = self.run_check(
            ['Buyers ask "which tool for my business," and that source matters. "Make something people want, and the rest mostly follows from that." (S092)']
        )
        self.assertEqual((ok, bad), (1, []))

    def test_comma_then_quote_then_id_with_no_space(self):
        _, _, bad = self.run_check(['"Always raise the biggest round you possibly can get,"(S011)'])
        self.assertEqual(len(bad), 1)

    def test_short_quotes_are_skipped(self):
        ok, internal, bad = self.run_check(['"Customers are always discontent." (S064)'])
        self.assertEqual((ok, internal, bad), (0, 0, []))

    def test_five_word_invented_quote_is_flagged(self):
        _, _, bad = self.run_check(['"$450 credited toward the build" (S113)'])
        self.assertEqual(len(bad), 1)

    def test_quote_shortened_with_ellipsis_verifies(self):
        for mark in ["...", "…", " [...] "]:
            ok, _, bad = self.run_check([f'"The biggest mistakes{mark}they\'re the mistakes of omission rather than commission" (S028)'])
            self.assertEqual((ok, bad), (1, []), mark)

    def test_ellipsis_pieces_out_of_order_or_far_apart_are_flagged(self):
        _, _, bad = self.run_check(['"Mistakes of omission rather than commission... the biggest mistakes" (S028)'])
        self.assertEqual(len(bad), 1)
        _, _, bad = self.run_check(['"Stick with big, easy decisions... the mistakes of omission rather than commission" (S090)'])
        self.assertEqual(len(bad), 1)

    def test_ellipsis_does_not_excuse_changed_words(self):
        _, _, bad = self.run_check(['"The biggest mistakes... are the mistakes of omission rather than commission" (S028)'])
        self.assertEqual(len(bad), 1)

    def test_ellipsis_pieces_of_filler_words_are_flagged(self):
        _, _, bad = self.run_check(['"The mistakes ... of ... the mistakes of omission rather" (S028)'])
        self.assertEqual(len(bad), 1)

    def test_ellipsis_piece_must_be_whole_words(self):
        _, _, bad = self.run_check(['"The biggest mis... the mistakes of omission rather than commission" (S028)'])
        self.assertEqual(len(bad), 1)

    def test_real_quote_with_the_wrong_source_id_is_flagged(self):
        ok, _, bad = self.run_check(['"We can afford to lose money but we can\'t afford to lose reputation." (S090)'])
        self.assertEqual(ok, 0)
        self.assertEqual(bad[0][2], "the brain cites it as S028, not S090")

    def test_any_id_in_a_multi_id_citation_counts(self):
        for cite in ["(S090, S028)", "(S028, S090)", "[S090; S028]", "(S028 and S090)"]:
            ok, _, bad = self.run_check([f'"Stick with big, “easy” decisions and eschew activity." {cite}'])
            self.assertEqual((ok, bad), (1, []), cite)

    def test_brain_line_without_an_id_does_not_block_a_quote(self):
        ok, _, bad = self.run_check(['"An entry that carries no source id at all in the brain." (S050)'])
        self.assertEqual((ok, bad), (1, []))


if __name__ == "__main__":
    unittest.main()
