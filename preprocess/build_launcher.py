#!/usr/bin/env python3
"""Generate the self-contained Windows launcher `run_preprocess.bat`.

Reads `launcher_template.bat.in`, injects configuration, and appends every
pipeline script (run_preprocess.py + the four numbered steps) base64-encoded so
the single .bat can reconstruct them on a machine that has never seen Python.

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
]
ENTRY = "run_preprocess.py"
PY_VERSION = "3.12.8"
DEPS = "numpy Pillow h5py scipy tqdm"
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

    template = TEMPLATE.read_text(encoding="utf-8")
    batch = (template
             .replace("@@@PP_VERSION@@@", read_pp_version())
             .replace("@@@PY_VERSION@@@", PY_VERSION)
             .replace("@@@SCRIPTS@@@", " ".join(SCRIPTS))
             .replace("@@@ENTRY@@@", ENTRY)
             .replace("@@@DEPS@@@", DEPS)
             .replace("@@@IMPORT_CHECK@@@", IMPORT_CHECK)
             .replace("@@@EMBEDDED@@@", "\n".join(embedded)))

    # cmd.exe is happiest with CRLF; base64/ASCII body keeps the file ASCII-clean.
    data = "\r\n".join(batch.splitlines()) + "\r\n"
    OUTPUT.write_bytes(data.encode("ascii"))

    kb = OUTPUT.stat().st_size / 1024
    print(f"[OK] {OUTPUT.name} genere ({kb:.1f} Ko, {len(SCRIPTS)} scripts embarques)")


if __name__ == "__main__":
    main()
