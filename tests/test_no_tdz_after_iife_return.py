"""Guard against a const/let stranded after an IIFE's `return`.

The core singletons are `const Foo = (() => { … return {…}; })()`, and several of them
keep declaring helper FUNCTIONS after that `return` — which works, because function
declarations are hoisted. A `const` or `let` placed in the same region does NOT: the
statement never executes, so the binding stays in its temporal dead zone forever and the
first read throws "Cannot access 'x' before initialization" at runtime, far from the
declaration.

That shipped once (web v1.27.1): a manifest cache declared next to the function using it,
past the return, made every bricked dataset fall back to a slice stack that does not
exist. Nothing caught it — the syntax is valid and the file parses.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DECL = re.compile(r"^(?P<indent> {2,4})(?P<kind>const|let|var)\s+(?P<name>[A-Za-z_$][\w$]*)")


def _stranded_declarations(path: Path):
    """Module-scope const/let between the IIFE's top-level `return {` and its close.

    The scan stops at the IIFE's closing `})();` — anything past it is ordinary
    top-level code (event listeners and the like), whose 2-space-indented bodies are
    inside functions that run normally and must not be reported.
    """
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    ret = next((i for i, l in enumerate(lines) if re.match(r"^ {2}return \{", l)), None)
    if ret is None:
        return []
    end = next((i for i in range(ret + 1, len(lines))
                if re.match(r"^\}\)\(\);?\s*$", lines[i])), len(lines))
    out = []
    for i in range(ret + 1, end):
        m = DECL.match(lines[i])
        # Only the IIFE's own scope (2-space indent); deeper indents are inside functions
        # and execute normally when that function runs.
        if m and len(m.group("indent")) == 2 and m.group("kind") in ("const", "let"):
            out.append((i + 1, m.group("kind"), m.group("name")))
    return out


class TestNoTemporalDeadZone(unittest.TestCase):
    def test_core_singletons_have_no_stranded_bindings(self):
        targets = sorted(
            list((ROOT / "js" / "core").glob("*.js"))
            + list((ROOT / "js" / "viewers").glob("*.js"))
            + list((ROOT / "js" / "pages").glob("*.js"))
            + list((ROOT / "js" / "components").glob("*.js"))
        )
        self.assertTrue(targets, "no sources found — check the layout")
        offenders = {}
        for path in targets:
            found = _stranded_declarations(path)
            if found:
                offenders[str(path.relative_to(ROOT))] = found
        self.assertEqual(
            offenders, {},
            "const/let declared after the IIFE return never initialises (TDZ at runtime); "
            "move it up with the other module state:\n"
            + "\n".join(f"  {f}: {d}" for f, d in offenders.items()),
        )


if __name__ == "__main__":
    unittest.main()
