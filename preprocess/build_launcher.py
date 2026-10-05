#!/usr/bin/env python3
"""Generate the self-contained Windows launcher `run_preprocess.bat`.

Reads `launcher_template.bat.in`, injects configuration, and appends every
pipeline script (run_preprocess.py, the numbered steps, the 2D importer and the
tracking attachment) base64-encoded so the single .bat can reconstruct them on a
machine that has never seen Python.

Run this whenever a pipeline .py or the template changes:
    python build_launcher.py
"""
import base64
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "launcher_template.bat.in"
OUTPUT = HERE / "run_preprocess.bat"

# Embedding order — index 0 is the entry point. Must stay in this order: the .bat
# extracts block N for the Nth name in SCRIPTS.
SCRIPTS = [
    "run_preprocess.py",
    "1-ims_metadata.py",
    "2-image_processor.py",
    "3-chunk_packer.py",
    "4-catalog_generator.py",
    "2d_importer.py",
    # Attaching a tracking that ships as a .imaris_track container needs nothing more.
    # Extracting one from a .ims or a workbook also needs the lab's SCRIPTS/Analysis.py
    # and pandas, which this launcher does not install: the orchestrator says so.
    "5-tracking_importer.py",
    "tracking_sources.py",
]
ENTRY = "run_preprocess.py"
# The download-bundle tool lives in ../tools/ but is embedded too (the block after the
# scripts) so the self-contained launcher can extract it on a fresh machine. The
# orchestrator finds it in either tools/ (repo) or next to itself (extracted).
DOWNLOAD_TOOL = "build_download_bundles.py"
PY_VERSION = "3.12.8"
# Pinned: the pipeline's output must not change between two machines because one of
# them installed a newer numpy or scipy. These are the versions the preprocessing tests
# (tests/test_preprocess_*.py) were run with on Python 3.12.
DEPS = "numpy==2.5.1 Pillow==11.1.0 h5py==3.16.0 scipy==1.16.0 tqdm==4.67.1"
IMPORT_CHECK = "import numpy, PIL, h5py, scipy, tqdm"


def read_pp_version() -> str:
    text = (HERE / "run_preprocess.py").read_text(encoding="utf-8")
    m = re.search(r'__version__\s*=\s*"([^"]+)"', text)
    if not m:
        sys.exit("[FATAL] __version__ introuvable dans run_preprocess.py")
    return m.group(1)


def encode_block(index: int, path: Path) -> list[str]:
    raw = path.read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    lines = [f":: ---- [{index}] {path.name} ({len(raw)} octets) ----"]
    lines += [f"#{index}#{b64[i:i + 76]}" for i in range(0, len(b64), 76)]
    return lines


def main() -> None:
    if not TEMPLATE.exists():
        sys.exit(f"[FATAL] Template introuvable : {TEMPLATE}")

    embedded: list[str] = []
    for index, name in enumerate(SCRIPTS):
        path = HERE / name
        if not path.exists():
            sys.exit(f"[FATAL] Script du pipeline introuvable : {path}")
        embedded += encode_block(index, path)

    # Download-bundle tool (index 5), embedded from ../tools/.
    dl_path = HERE.parent / "tools" / DOWNLOAD_TOOL
    if not dl_path.exists():
        sys.exit(f"[FATAL] Outil download introuvable : {dl_path}")
    embedded += encode_block(len(SCRIPTS), dl_path)

    template = TEMPLATE.read_text(encoding="utf-8")
    batch = (template
             .replace("@@@PP_VERSION@@@", read_pp_version())
             .replace("@@@PY_VERSION@@@", PY_VERSION)
             .replace("@@@SCRIPTS@@@", " ".join(SCRIPTS))
             .replace("@@@ENTRY@@@", ENTRY)
             .replace("@@@DEPS@@@", DEPS)
             .replace("@@@DOWNLOAD_INDEX@@@", str(len(SCRIPTS)))
             .replace("@@@IMPORT_CHECK@@@", IMPORT_CHECK)
             .replace("@@@EMBEDDED@@@", "\n".join(embedded)))

    # cmd.exe is happiest with CRLF; base64/ASCII body keeps the file ASCII-clean.
    data = "\r\n".join(batch.splitlines()) + "\r\n"
    OUTPUT.write_bytes(data.encode("ascii"))

    kb = OUTPUT.stat().st_size / 1024
    print(f"[OK] {OUTPUT.name} genere ({kb:.1f} Ko, {len(SCRIPTS) + 1} scripts embarques)")


if __name__ == "__main__":
    main()
