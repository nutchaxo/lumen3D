"""Conformance run of dev_server.py:_compat_satisfies against the shared vector.
Its twin (tests/test_compat.js) runs the SAME vector against js/core/compat.js —
both must pass for any change to the compat semantics."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dev_server as ds

vector = json.loads((Path(__file__).parent / "compat-vector.json").read_text(encoding="utf-8"))
failed = 0
for case in vector["cases"]:
    ok, reason = ds._compat_satisfies(case["platform"], case["decl"])
    if ok != case["expect"]:
        failed += 1
        print(f"  FAIL platform={case['platform']!r} decl={case['decl']!r} "
              f"→ {ok} (expected {case['expect']}) [{case['why']}] reason={reason}")
if failed:
    print(f"{failed}/{len(vector['cases'])} CASES FAILED")
    sys.exit(1)
print(f"ALL {len(vector['cases'])} COMPAT CASES PASSED (python)")
