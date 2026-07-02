"""Parity: dev_server.py canonical plugin hash vs the shared vector.
Twin of tests/test_plugin_trust.js (Node) — both must agree, guaranteeing the
browser and the server compute the same identity hash over the same bytes."""
import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dev_server as ds

v = json.loads((Path(__file__).parent / "plugin-trust-vector.json").read_text(encoding="utf-8"))
fails = 0

for c in v["files"]:
    got = ds._sha256_bytes(base64.b64decode(c["b64"]))
    if got != c["fileHash"]:
        fails += 1
        print(f"  FAIL fileHash {c['rel']}: {got} != {c['fileHash']}")

composite = ds._plugin_hash({c["rel"]: c["fileHash"] for c in v["files"]})
if composite != v["pluginHash"]:
    fails += 1
    print(f"  FAIL pluginHash: {composite} != {v['pluginHash']}")

sf = v["singleFile"]
if ds._plugin_hash({sf["rel"]: sf["fileHash"]}) != sf["pluginHash"]:
    fails += 1
    print("  FAIL singleFile pluginHash")

if fails:
    print(f"{fails} PARITY FAILURES")
    sys.exit(1)
print(f"ALL {len(v['files']) + 2} PLUGIN-TRUST HASH CASES PASSED (python)")
