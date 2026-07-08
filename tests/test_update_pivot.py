"""Unit exercise of the pivot swap core: forward apply, reverse, and crash-replay
idempotency — the properties the whole update system's safety rests on."""
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, r"D:\Coding\WebPlatform")
import dev_server as ds

BASE = Path(__file__).parent / ".pivot-arena"


def build_arena():
    shutil.rmtree(BASE, ignore_errors=True)
    root, staging, old = BASE / "root", BASE / "staging", BASE / "old"
    for rel, content in {
        "index.html": "OLD index", "js/app.js": "OLD app",
        "stale.html": "OLD stale (removed upstream)",
        "api/config.json": "USER STATE (protected)",
        "user-added.txt": "USER FILE (unknown to manifests)",
    }.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    for rel, content in {
        "index.html": "NEW index", "js/app.js": "NEW app",
        "js/new-module.js": "NEW module",
    }.items():
        p = staging / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    plan = {"files": ["index.html", "js/app.js", "js/new-module.js"],
            "deletions": ["stale.html"]}
    j = {"plan": plan, "applied": 0}
    journal = BASE / "journal.json"
    journal.write_text(json.dumps(j))
    return root, staging, old, journal, j


def snap(root):
    return {str(p.relative_to(root)).replace("\\", "/"): p.read_text()
            for p in sorted(root.rglob("*")) if p.is_file()}


def check(name, cond):
    print(("  ok  " if cond else "  FAIL") + f" {name}")
    if not cond:
        sys.exit(1)


# 1. Full forward apply
root, staging, old, journal, j = build_arena()
before = snap(root)
ds._apply_plan(journal, j, root, staging, old)
after = snap(root)
check("new files promoted", after["index.html"] == "NEW index" and after["js/new-module.js"] == "NEW module")
check("stale file removed", "stale.html" not in after)
check("protected untouched", after["api/config.json"] == "USER STATE (protected)")
check("user file untouched", after["user-added.txt"] == "USER FILE (unknown to manifests)")
check("old mirror holds originals", (old / "index.html").read_text() == "OLD index"
      and (old / "stale.html").read_text() == "OLD stale (removed upstream)")

# 2. Full reverse from applied state
ds._reverse_plan(j, root, staging, old)
check("reverse restores exact tree", snap(root) == before)
check("staged copies back in staging", (staging / "index.html").read_text() == "NEW index"
      and (staging / "js/new-module.js").read_text() == "NEW module")

# 3. Crash mid-apply (simulate: apply first op only), then REPLAY to completion
root, staging, old, journal, j = build_arena()
one_op = {"plan": {"files": [], "deletions": ["stale.html"]}, "applied": 0}
ds._apply_plan(journal, one_op, root, staging, old)   # only the deletion happened
ds._apply_plan(journal, j, root, staging, old)         # full replay over partial state
after = snap(root)
check("replay after partial apply completes", after["index.html"] == "NEW index" and "stale.html" not in after)
check("replay never clobbers the mirror", (old / "stale.html").read_text() == "OLD stale (removed upstream)")

# 4. Crash mid-apply, then REVERSE from partial state
root, staging, old, journal, j = build_arena()
half = {"plan": {"files": ["index.html"], "deletions": ["stale.html"]}, "applied": 0}
before = snap(root)
ds._apply_plan(journal, half, root, staging, old)      # partial: 1 deletion + 1 promote
ds._reverse_plan(j, root, staging, old)                # reverse with the FULL plan
check("reverse from partial state restores exact tree", snap(root) == before)

# 5. Reverse is idempotent (double reverse)
ds._reverse_plan(j, root, staging, old)
check("double reverse is a no-op", snap(root) == before)

print("ALL PIVOT CORE TESTS PASSED")
shutil.rmtree(BASE, ignore_errors=True)
