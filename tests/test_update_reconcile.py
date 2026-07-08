"""Regression test for review finding #1: an interrupted rollback must NOT be
finalized forward. Reproduces the reported scenario and asserts the fix."""
import json, shutil, sys, hashlib
from pathlib import Path
sys.path.insert(0, r"D:\Coding\WebPlatform")
import dev_server as ds

BASE = Path(__file__).parent / ".recon-arena"

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()

def build(applied_then_partially_reverted):
    shutil.rmtree(BASE, ignore_errors=True)
    root, staging, old = BASE/"root", BASE/"staging", BASE/"old"
    for d in (root, staging, old): d.mkdir(parents=True)
    # Live tree AFTER a full apply to 1.5.0, then a PARTIAL reverse:
    # api/foo.js was reverted to OLD, index.html + changelog are still NEW.
    (root/"index.html").write_text("NEW index")
    (root/"api").mkdir(); (root/"api"/"foo.js").write_text("OLD foo")   # reverted
    (root/"changelog").mkdir(); (root/"changelog"/"changelog_1.5.0.md").write_text("v150")
    # version.json is the TARGET manifest (still live) — lists the NEW digests.
    files = {
        "index.html": hashlib.sha256(b"NEW index").hexdigest(),
        "api/foo.js": hashlib.sha256(b"NEW foo").hexdigest(),   # manifest says NEW, disk has OLD
    }
    (root/"version.json").write_text(json.dumps({"web":"1.5.0","files":files}))
    # old mirror holds the originals for a proper reverse
    (old/"index.html").write_text("OLD index")
    (old/"api").mkdir(); (old/"api"/"foo.js").write_text("OLD foo")
    plan = {"files":["api/foo.js","index.html"], "deletions":[]}
    j = {"phase": applied_then_partially_reverted, "target":"1.5.0","current":"1.4.3",
         "root":str(root),"staging":str(staging),"old":str(old),"plan":plan,"applied":2}
    ds.JOURNAL_FILE = BASE/"journal.json"
    ds.CHANGELOG_DIR = root/"changelog"
    ds.JOURNAL_FILE.write_text(json.dumps(j))
    return root

# Scenario A: journal still says "applied" (old buggy behavior would finalize forward).
# With the manifest-verify defense, a half-reverted tree (foo.js=OLD ≠ manifest) must roll BACK.
root = build("applied")
ds._reconcile_pivot()
foo = (root/"api"/"foo.js").read_text()
idx = (root/"index.html").read_text()
assert not ds.JOURNAL_FILE.exists(), "journal should be consumed"
assert foo == "OLD foo" and idx == "OLD index", f"must fully roll back, got foo={foo!r} idx={idx!r}"
print("A ok: phase='applied' + torn tree → rolled back (not falsely finalized)")

# Scenario B: journal says "rolling_back" → always roll back regardless of version.
root = build("rolling_back")
ds._reconcile_pivot()
assert (root/"index.html").read_text() == "OLD index", "rolling_back must complete the reverse"
print("B ok: phase='rolling_back' → reverse completed")

# Scenario C: a GENUINELY complete apply (tree matches manifest) → roll FORWARD.
# staging lives under a throwaway workdir (mirrors prod backups/tmp-<ts>/tree), so
# _finalize_success's rmtree(staging.parent) cannot touch root.
shutil.rmtree(BASE, ignore_errors=True)
root, staging, old = BASE/"root", BASE/"work"/"tree", BASE/"old"
for d in (root, staging, old): d.mkdir(parents=True)
(root/"index.html").write_text("NEW index")
(root/"changelog").mkdir(); (root/"changelog"/"changelog_1.5.0.md").write_text("v")
(root/"version.json").write_text(json.dumps({"web":"1.5.0","files":{"index.html":hashlib.sha256(b"NEW index").hexdigest()}}))
j = {"phase":"applied","target":"1.5.0","current":"1.4.3","root":str(root),
     "staging":str(staging),"old":str(old),"plan":{"files":["index.html"],"deletions":[]},"applied":1}
ds.JOURNAL_FILE = BASE/"journal.json"; ds.CHANGELOG_DIR = root/"changelog"
ds.JOURNAL_FILE.write_text(json.dumps(j))
ds._reconcile_pivot()
assert not ds.JOURNAL_FILE.exists() and (root/"index.html").read_text() == "NEW index"
print("C ok: complete apply (tree==manifest) → finalized forward")

print("\nRECONCILE REGRESSION TESTS PASSED")
shutil.rmtree(BASE, ignore_errors=True)
