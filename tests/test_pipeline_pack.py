"""Regression for the downloadable pipeline pack (dev_server.py:_pipeline_local).

Since web v1.42.0 a pack is named after the PIPELINE version it contains, not the
platform's — so a pack called 0.15.0 supersedes one called 1.41.0, and a plain
version sort picks the wrong file forever. More than one pack really does end up on
disk: a copy-over update (PHP hosts) leaves the previous release's behind.

Twin: tests/test_pipeline_pack.php.
"""
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dev_server as ds

fails = 0


def check(name, cond):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name)
    if not cond:
        fails += 1


def make_pack(path: Path, doc: dict, mtime: int):
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(f"{path.stem}/VERSION.json", json.dumps(doc))
    os.utime(path, (mtime, mtime))


def pick(packs, install_version="1.42.0"):
    """Newest-first name chosen by _pipeline_local for a synthetic assets/pipeline.

    `packs` are (name, VERSION.json, mtime) in write order.
    """
    with tempfile.TemporaryDirectory(prefix="lumen-pack-") as tmp:
        root = Path(tmp)
        (root / "changelog").mkdir()
        (root / "changelog" / f"changelog_{install_version}.md").write_text("x", encoding="utf-8")
        pdir = root / "assets" / "pipeline"
        pdir.mkdir(parents=True)
        for name, doc, mtime in packs:
            make_pack(pdir / name, doc, mtime)

        saved = (ds.PIPELINE_DIR, ds.CHANGELOG_DIR)
        ds.PIPELINE_DIR, ds.CHANGELOG_DIR = pdir, root / "changelog"
        try:
            got = ds._pipeline_local("leger")
            return got.name if got else None
        finally:
            ds.PIPELINE_DIR, ds.CHANGELOG_DIR = saved


T0 = 1_750_000_000
LEGACY = ("lumen3d-pipeline-leger-1.41.0.zip",
          {"bundleVersion": "1.41.0", "preprocessVersion": "0.14.1"}, T0)          # pre-v1.42.0: no platformVersion
CURRENT = ("lumen3d-pipeline-leger-0.15.0.zip",
           {"bundleVersion": "0.15.0", "preprocessVersion": "0.15.0",
            "platformVersion": "1.42.0"}, T0 + 3600)

check("single pack is served whatever its naming",
      pick([LEGACY]) == "lumen3d-pipeline-leger-1.41.0.zip")
check("pack declaring THIS install wins over a higher-numbered leftover",
      pick([LEGACY, CURRENT]) == "lumen3d-pipeline-leger-0.15.0.zip")
check("...even when it was written first",
      pick([CURRENT, ("lumen3d-pipeline-leger-9.9.9.zip",
                      {"bundleVersion": "9.9.9", "preprocessVersion": "9.9.9",
                       "platformVersion": "1.40.0"}, T0 + 7200)])
      == "lumen3d-pipeline-leger-0.15.0.zip")
check("neither matches this install -> most recently written",
      pick([("lumen3d-pipeline-leger-0.15.0.zip",
             {"bundleVersion": "0.15.0", "preprocessVersion": "0.15.0",
              "platformVersion": "1.41.1"}, T0),
            ("lumen3d-pipeline-leger-0.16.0.zip",
             {"bundleVersion": "0.16.0", "preprocessVersion": "0.16.0",
              "platformVersion": "1.41.9"}, T0 + 3600)])
      == "lumen3d-pipeline-leger-0.16.0.zip")
check("no pack at all -> None", pick([]) is None)

# The pack the repo actually builds must carry the pipeline version in its name:
# that number is what the admin panel reports everywhere else.
built = sorted((Path(__file__).resolve().parents[1] / "assets" / "pipeline")
               .glob("lumen3d-pipeline-leger-*.zip"))
if built:
    doc = ds._pipeline_pack_doc(built[-1])
    check(f"built pack name carries its pipeline version ({built[-1].name})",
          built[-1].stem.endswith(str(doc.get("preprocessVersion"))))
    check("bundleVersion == preprocessVersion",
          doc.get("bundleVersion") == doc.get("preprocessVersion"))
    check("platformVersion recorded", bool(doc.get("platformVersion")))
else:
    print("  skip  no built pack in assets/pipeline (run tools/build_pipeline_bundle.py)")

if fails:
    print(f"\n{fails} PIPELINE-PACK CHECKS FAILED")
    sys.exit(1)
print("\nALL PIPELINE-PACK CHECKS PASSED (python)")
