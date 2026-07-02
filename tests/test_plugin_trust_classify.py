"""Regression for the trust classifier (dev_server.py:_classify_plugin) covering the
P2-4 review fixes: sandboxed-approval overrides dev-trust, cap-subset enforcement,
and hash-pinning. Uses the bundled screenshot-sandboxed plugin as a fixture."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dev_server as ds

MD = ds.MODULES_DIR / "tools/screenshot-sandboxed"
H = ds._plugin_hash(ds._plugin_file_hashes(MD))
DECLARED = sorted(ds._plugin_declared_caps(MD))
PATH = "tools/screenshot-sandboxed"
fails = 0


def check(name, cond):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name)
    if not cond:
        fails += 1


sandbox_ap = [{"path": PATH, "sha256": H, "mode": "sandboxed", "caps": DECLARED}]
trusted_ap = [{"path": PATH, "sha256": H, "mode": "trusted", "caps": DECLARED}]

ds._DEV_TRUST = True
check("sandboxed approval WINS over dev-trust (containment override)",
      ds._classify_plugin(PATH, MD, sandbox_ap, None)["tier"] == "sandboxed")
check("dev-trust covers an unapproved plugin", ds._classify_plugin(PATH, MD, [], None)["tier"] == "dev")
check("dev-trust covers a 'trusted' approval (in-page either way)",
      ds._classify_plugin(PATH, MD, trusted_ap, None)["tier"] == "dev")

ds._DEV_TRUST = False
check("prod: sandboxed approval -> sandboxed", ds._classify_plugin(PATH, MD, sandbox_ap, None)["tier"] == "sandboxed")
check("prod: no approval -> untrusted", ds._classify_plugin(PATH, MD, [], None)["tier"] == "untrusted")
check("prod: hash drift voids approval",
      ds._classify_plugin(PATH, MD, [{"path": PATH, "sha256": "0" * 64, "mode": "sandboxed", "caps": DECLARED}], None)["tier"] == "untrusted")
check("prod: under-granted caps void approval",
      ds._classify_plugin(PATH, MD, [{"path": PATH, "sha256": H, "mode": "sandboxed", "caps": ["ui.toast"]}], None)["tier"] == "untrusted")

if fails:
    print(f"\n{fails} CLASSIFY CHECKS FAILED")
    sys.exit(1)
print("\nALL TRUST-CLASSIFY CHECKS PASSED (python)")
