"""Regression for the trust classifier (dev_server.py:_classify_plugin) covering the
P2-4 + audit fixes: sandbox:true routes to the sandbox lane regardless of trust tier,
sandboxed-approval overrides dev-trust, cap-subset + hash-pinning void a stale approval.
Twin: tests/test_plugin_trust_classify.php. Uses the bundled fixtures."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dev_server as ds

SB = ds.MODULES_DIR / "tools/screenshot-sandboxed"   # sandbox:true
REG = ds.MODULES_DIR / "tools/screenshot"            # regular in-page
H = ds._plugin_hash(ds._plugin_file_hashes(SB))
DECLARED = sorted(ds._plugin_declared_caps(SB))
SBP, REGP = "tools/screenshot-sandboxed", "tools/screenshot"
fails = 0


def check(name, cond):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name)
    if not cond:
        fails += 1


sandbox_ap = [{"path": SBP, "sha256": H, "mode": "sandboxed", "caps": DECLARED}]

# `sandbox: true` decides the LANE — always the iframe, whatever the trust tier.
ds._DEV_TRUST = True
check("dev + sandbox:true plugin -> sandboxed (author lane)", ds._classify_plugin(SBP, SB, [], None)["tier"] == "sandboxed")
check("dev + regular plugin -> dev (in-page)", ds._classify_plugin(REGP, REG, [], None)["tier"] == "dev")

ds._DEV_TRUST = False
check("prod: sandboxed approval -> sandboxed", ds._classify_plugin(SBP, SB, sandbox_ap, None)["tier"] == "sandboxed")
check("prod: no approval -> untrusted", ds._classify_plugin(SBP, SB, [], None)["tier"] == "untrusted")
check("prod: regular no approval -> untrusted", ds._classify_plugin(REGP, REG, [], None)["tier"] == "untrusted")
check("prod: hash drift voids approval",
      ds._classify_plugin(SBP, SB, [{"path": SBP, "sha256": "0" * 64, "mode": "sandboxed", "caps": DECLARED}], None)["tier"] == "untrusted")
check("prod: under-granted caps void approval",
      ds._classify_plugin(SBP, SB, [{"path": SBP, "sha256": H, "mode": "sandboxed", "caps": ["ui.toast"]}], None)["tier"] == "untrusted")

if fails:
    print(f"\n{fails} CLASSIFY CHECKS FAILED")
    sys.exit(1)
print("\nALL TRUST-CLASSIFY CHECKS PASSED (python)")
