#!/usr/bin/env python
"""
Check every quoted line in a council session against the seats' brains.

Usage:
  python .claude/skills/roast-room/scripts/check_quotes.py <session folder>

Scans round-*.md and verdict.md for quotes of 5 or more words attributed to a source id, like "..." (S095), and looks
for each in the brain files. A quote that is in no brain is either a quote of
another seat or the founder (fine if it appears in an earlier round file of the
same session) or an invented quote (flag it and remove it from the verdict).
Exit code 1 if any quote is unaccounted for.

Quotes may hold nested quote marks, like "Stick with big, "easy" decisions ..." (S090),
and any mix of straight, curly, single and double quote marks. A quote shortened with an ellipsis
("The biggest mistakes... are the mistakes of omission") verifies when its pieces appear in order,
each within a short gap of the one before. A quote must also be in a brain line that cites the same
source id; a real line credited to the wrong source is flagged.
"""
import re
import sys
from pathlib import Path

BRAINS = Path(__file__).resolve().parents[1] / "brains"

# a closing quote, then a source id within 40 characters, e.g. "..." (S095), "..." [S048, 2026]
# or "..." (Lead magnets, S112)
CLOSE_THEN_ID = re.compile(r"""["”](?=[^\n"“”]{0,40}?[(\[](?:[^()\[\]\n"“”]{0,30}?,\s*)?(S\d{3}))""")
SOURCE_ID = re.compile(r"S\d{3}")
# the citation after a closing quote mark: everything up to its closing bracket
CITATION = re.compile(r"""[^\n"“”]{0,40}?[(\[][^()\[\]\n]{0,80}""")
# "...", "…" or "[...]" marks words left out of a quote
ELLIPSIS = re.compile(r"\[?(?:\.\.\.|…)\]?")
# the most normalized characters an ellipsis may stand for
GAP = 300
# each piece of a shortened quote must have this many words, so "The ... of ... the" proves nothing
MIN_PIECE_WORDS = 3


def norm(s):
    s = s.lower().replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    # a single quote used as a quotation mark (not inside a word, like don't) is punctuation
    s = re.sub(r"(?<![a-z0-9])'|'(?![a-z0-9])", " ", s)
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def is_open(line, i):
    """Whether the quote mark at line[i] opens a quote (curly marks say so; straight ones by context)."""
    ch = line[i]
    if ch in "“”":
        return ch == "“"
    nxt = line[i + 1] if i + 1 < len(line) else " "
    prev = line[i - 1] if i > 0 else " "
    # a mark right before "(" or "[" closes a quote, as in get,"(S011)
    return not nxt.isspace() and nxt not in "([" and not (prev.isalnum() or prev in ".!?")


def quote_ending_at(line, end):
    """The text of the quote whose closing mark is line[end], or None.

    Scans back to the line start. The quote opens at the matching opening mark, so a nested quote
    ("big, "easy" decisions") stays inside it and an earlier, separate quote stays out of it.
    An opening mark before that which never closes encloses the quote, so the quote widens to it.
    """
    depth, start = 1, None
    for i in range(end - 1, -1, -1):
        if line[i] not in '"“”':
            continue
        if not is_open(line, i):
            depth += 1
            continue
        depth -= 1
        if start is None and depth == 0:
            start = i + 1
        elif depth < 0:
            start, depth = i + 1, 0
    if start is None:
        return None
    return line[start:end]


def find_quotes(text):
    quotes = []
    for line in text.split("\n"):
        for m in CLOSE_THEN_ID.finditer(line):
            if is_open(line, m.start()):
                continue
            q = quote_ending_at(line, m.start())
            if q is not None and 20 <= len(q) <= 400:
                cite = CITATION.match(line, m.end())
                quotes.append((q, set(SOURCE_ID.findall(cite.group() if cite else m.group(1)))))
    return quotes


def in_text(quote, hay):
    """Whether the quote is in the normalized text hay, allowing for ellipses."""
    parts = [f" {p} " for p in (norm(x) for x in ELLIPSIS.split(quote)) if p]
    if len(parts) <= 1:
        return norm(quote) in hay
    if any(len(p.split()) < MIN_PIECE_WORDS for p in parts):
        return False
    hay = f" {hay} "
    i = hay.find(parts[0])
    while i != -1:
        pos = i + len(parts[0]) - 1
        for p in parts[1:]:
            j = hay.find(p, pos)
            if j == -1 or j - pos > GAP:
                break
            pos = j + len(p) - 1
        else:
            return True
        i = hay.find(parts[0], i + 1)
    return False


def cited_elsewhere(quote, sids, brain_lines):
    """The ids the brain cites the quote under, when none of them is in sids; None when one fits.

    A brain line with no id, or a quote that only matches across lines, can't be checked, so it passes.
    """
    # a cheap filter first: a line can only hold the quote if it holds its first piece
    first = next((f" {p} " for p in (norm(x) for x in ELLIPSIS.split(quote)) if p), " ")
    hits = [ids for line, ids in brain_lines if first in f" {line} " and in_text(quote, line)]
    if not hits or any(not ids or ids & sids for ids in hits):
        return None
    return sorted(set().union(*hits))


def check(session, brains=BRAINS):
    session = Path(session)
    brain_raw = [p.read_text(encoding="utf-8", errors="replace") for p in Path(brains).rglob("*.md")]
    brain_text = norm(" ".join(brain_raw))
    brain_lines = [(norm(line), set(SOURCE_ID.findall(line))) for text in brain_raw for line in text.split("\n") if line.strip()]
    session_files = sorted(session.glob("round-*.md")) + [p for p in [session / "verdict.md"] if p.exists()]
    brief = norm((session / "brief.md").read_text(encoding="utf-8")) if (session / "brief.md").exists() else ""
    bad, ok, internal = [], 0, 0
    seen_session = ""
    for f in session_files:
        text = f.read_text(encoding="utf-8", errors="replace")
        for q, sids in find_quotes(text):
            nq = norm(q)
            if len(nq.split()) < 5:
                continue
            if in_text(q, brain_text):
                other = cited_elsewhere(q, sids, brain_lines)
                if other:
                    bad.append((f.name, q, f"the brain cites it as {', '.join(other)}, not {', '.join(sorted(sids))}"))
                else:
                    ok += 1
            elif in_text(q, seen_session) or in_text(q, brief):
                internal += 1
            else:
                bad.append((f.name, q, "not in a brain"))
        seen_session += " " + norm(text)
    return ok, internal, bad


def main():
    ok, internal, bad = check(sys.argv[1])
    print(f"brain quotes verified: {ok}; quotes of earlier rounds or the brief: {internal}; unverified: {len(bad)}")
    for name, q, why in bad:
        print(f"  UNVERIFIED [{name}] \"{q[:160]}\" ({why})")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
