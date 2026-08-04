#!/usr/bin/env python3
"""Assemble the redistributable pipeline pack offered by the admin panel.

The pack gives a lab technician, on a Windows PC that has never seen this
project, everything needed to turn raw microscope output into datasets the web
platform can serve:

  * the VOLUME pipeline   — Imaris ``.ims`` stacks -> bricked, LOD-pyramided datasets
  * the TRACKING pipeline — Imaris Excel exports   -> ``.imaris_track`` + ``.glb``
  * a worked example for each, so ``RUN.bat`` is runnable the moment it is unzipped
  * ``RUN.bat`` itself: integrity check -> Python check -> dependency check -> menu

Two editions:

    --lite (default)  ~3 MB.  Sources + examples only; RUN.bat finds a system
                      Python or downloads the embeddable one, then pip-installs.
                      Small enough to ship inside the web release artifact, so
                      the admin panel can always offer it with zero server work.

    --full            ~70 MB. Adds ``.runtime/python`` with every dependency
                      ALREADY INSTALLED, so the technician needs no network at
                      all. Built by the release CI and attached to the GitHub
                      release; too big to live in the web release zip.

Why pre-install rather than vendor wheels: measured, a pre-installed slim
runtime is ~72 MB zipped against ~86 MB for embeddable + wheels + pip + get-pip,
and it removes pip, the bootstrap and the ``._pth`` rewrite from the technician's
first run entirely.

VERSIONING — the pack carries the PIPELINE's version, not the web platform's.
Naming it after the platform (as it was until web v1.42.0) produced a pack called
``…-1.41.0.zip`` while every version readout in the admin panel said ``0.15.0``:
two numbers for one thing, one of them necessarily wrong. The pack IS the
"Outil de Preprocessing" component of CLAUDE.md §1.5, so its version is
``preprocess/run_preprocess.py:__version__`` — which covers everything shipped
inside, tracking scripts and launcher included. Bump it when the pack's contents
change. The platform version it was built alongside is kept in VERSION.json for
traceability only.

Usage:
    python tools/build_pipeline_bundle.py                     # lite -> assets/pipeline/
    python tools/build_pipeline_bundle.py --full --out dist   # complete edition
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = Path(__file__).resolve().parent / "pipeline_bundle"

# --- what goes in -----------------------------------------------------------

# The volume pipeline. run_preprocess.py resolves its steps as siblings
# (SCRIPT_DIR / "<n>-….py"), so these must land in one flat directory.
PIPELINE_SCRIPTS = (
    "run_preprocess.py",
    "1-ims_metadata.py",
    "2-image_processor.py",
    "3-chunk_packer.py",
    "4-catalog_generator.py",
    "5-tracking_importer.py",
)

# Optional extra invoked by --with-downloads. run_preprocess.py accepts it either
# in tools/ (repo layout) or beside itself (extracted layout) — we use the latter.
DOWNLOAD_TOOL = "build_download_bundles.py"

# The tracking pipeline, curated. SCRIPTS/ also holds one-off dev utilities with
# hardcoded lab paths (check.py, check_output.py, verify_*.py) and two stale
# copy-paste fragments (patch1.py — which does not even compile, patch2.py); none
# of them belong in a technician's hands.
TRACKING_SCRIPTS = (
    "Analysis.py",
    "export_html.py",
    "export_mesh.py",
    "surface_reconstruction.py",
)

# Import name -> pip requirement, for BOTH pipelines. openpyxl and orjson are the
# ones missing from preprocess/requirements.txt: pandas needs openpyxl to read the
# Imaris .xlsx, and export_html.py imports orjson unconditionally.
DEPENDENCIES = (
    ("numpy", "numpy"),
    ("PIL", "Pillow"),
    ("h5py", "h5py"),
    ("scipy", "scipy"),
    ("tqdm", "tqdm"),
    ("pandas", "pandas"),
    ("openpyxl", "openpyxl"),
    ("orjson", "orjson"),
    ("tifffile", "tifffile"),
)

PY_VERSION = "3.12.10"
PY_EMBED_URL = f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip"

# Fixed DOS timestamp so the archive bytes do not vary with build-machine mtimes
# (same convention as tools/build_release.py).
ZIP_ENTRY_DATE = (1980, 1, 1, 0, 0, 0)


# ---------------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------------

def _changelog_version(directory: Path) -> str:
    """Newest changelog filename IS the web platform version (see CLAUDE.md §1.5)."""
    best = (0, 0, 0)
    for path in directory.glob("changelog_*.md"):
        m = re.fullmatch(r"changelog_(\d+)\.(\d+)\.(\d+)\.md", path.name)
        if m:
            best = max(best, tuple(int(g) for g in m.groups()))
    return ".".join(str(p) for p in best)


def _script_version(path: Path) -> str:
    m = re.search(r'__version__\s*=\s*"([^"]+)"', path.read_text(encoding="utf-8"))
    return m.group(1) if m else "0.0.0"


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _render(template: Path, mapping: dict) -> str:
    text = template.read_text(encoding="utf-8")
    for key, value in mapping.items():
        text = text.replace(f"@@@{key}@@@", str(value))
    leftover = re.findall(r"@@@[A-Z_]+@@@", text)
    if leftover:
        raise SystemExit(f"[FATAL] placeholder(s) non substitue(s) dans {template.name}: {sorted(set(leftover))}")
    return text


def _copy(src: Path, dst: Path):
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def _write_text(path: Path, text: str):
    """Write UTF-8 with LF endings regardless of the build host.

    Path.write_text translates \\n to os.linesep, so the same source would produce
    CRLF on a Windows build and LF on the Linux release runner — different bytes,
    different sha256, a pack that is not reproducible across build machines. The
    repo already pins zip entry dates for exactly this reason.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


# ---------------------------------------------------------------------------
#  Staging the tree
# ---------------------------------------------------------------------------

def stage_sources(stage: Path):
    """Copy the two pipelines and their examples into the bundle layout.

    Layout is load-bearing, not cosmetic:
      pipeline/          run_preprocess.py resolves its steps as siblings
      tracking/SCRIPTS/  Analysis.py derives DATA/ and OUTPUT/ from its PARENT dir,
      tracking/DATA/     so the sample folders must sit beside SCRIPTS, not inside it
      tracking/OUTPUT/
      input/             run_preprocess.py globs *.ims here, non-recursively
      output/            default destination, INSIDE the bundle (the repo launcher
                         defaulted to ..\\DATA_WEB, which lands outside an unzipped pack)
    """
    for name in PIPELINE_SCRIPTS:
        src = REPO_ROOT / "preprocess" / name
        if not src.is_file():
            raise SystemExit(f"[FATAL] script de pipeline introuvable : {src}")
        _copy(src, stage / "pipeline" / name)

    # build_download_bundles.py carries a hardcoded lab path in RAW_DATA_DIRS. It is
    # inert in the normal flow (run_preprocess.py always passes --raw-dir, and
    # find_ims skips bases that do not exist), but shipping another site's directory
    # layout to a third party is gratuitous, so it is blanked in the copy.
    dl_src = REPO_ROOT / "tools" / DOWNLOAD_TOOL
    if dl_src.is_file():
        text = dl_src.read_text(encoding="utf-8")
        text, n = re.subn(
            r"RAW_DATA_DIRS\s*=\s*\[[^\]]*\]",
            "RAW_DATA_DIRS = []  # renseigne via --raw-dir (voir run_preprocess.py)",
            text,
            count=1,
        )
        if not n:
            print("[WARN] RAW_DATA_DIRS introuvable dans build_download_bundles.py — copie telle quelle")
        _write_text(stage / "pipeline" / DOWNLOAD_TOOL, text)

    for name in TRACKING_SCRIPTS:
        src = REPO_ROOT / "SCRIPTS" / name
        if not src.is_file():
            raise SystemExit(f"[FATAL] script de tracking introuvable : {src}")
        _copy(src, stage / "tracking" / "SCRIPTS" / name)

    examples = REPO_ROOT / "preprocess" / "examples"
    ims_examples = sorted((examples / "ims").glob("*.ims"))
    if not ims_examples:
        raise SystemExit(f"[FATAL] aucun .ims d'exemple dans {examples / 'ims'} "
                         f"— lancez d'abord tools/gen_pipeline_examples.py")
    for src in ims_examples:
        _copy(src, stage / "input" / src.name)

    tracking_examples = sorted((examples / "tracking").glob("*/*.xlsx"))
    if not tracking_examples:
        raise SystemExit(f"[FATAL] aucun .xlsx d'exemple dans {examples / 'tracking'} "
                         f"— lancez d'abord tools/gen_pipeline_examples.py")
    for src in tracking_examples:
        _copy(src, stage / "tracking" / "DATA" / src.parent.name / src.name)

    # Directories the pipelines write into. A zip cannot carry an empty folder, so
    # a marker file is what actually makes them survive the round-trip. The marker
    # carries text rather than being empty for two reasons: it tells the technician
    # what the folder is for, and `certutil -hashfile` — which RUN.bat uses to check
    # the manifest — FAILS on a zero-byte file with ERROR_FILE_INVALID.
    placeholders = {
        "output": "Les jeux de donnees traites apparaissent ici, dans fixed\\ ou live\\.\n"
                  "Copiez le dossier produit dans le DATA_WEB\\ du serveur pour le publier.\n",
        "tracking/OUTPUT": "Les resultats d'analyse de tracking apparaissent ici,\n"
                           "dans un sous-dossier horodate par execution.\n",
    }
    for rel, note in placeholders.items():
        d = stage / rel
        d.mkdir(parents=True, exist_ok=True)
        _write_text(d / "LISEZ-MOI.txt", note)


# ---------------------------------------------------------------------------
#  The complete edition's Python runtime
# ---------------------------------------------------------------------------

def _download(url: str, dest: Path):
    print(f"[bundle] telechargement {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "lumen3d-bundle-builder"})
    with urllib.request.urlopen(req, timeout=180) as r, dest.open("wb") as fh:
        shutil.copyfileobj(r, fh)
    print(f"[bundle]   -> {dest.name} ({dest.stat().st_size / 1024 / 1024:.1f} MiB)")


def _write_pth(pydir: Path):
    """Write the embeddable distribution's path file.

    The stock advice ("uncomment ``import site``") is wrong here in two ways:

      1. Re-enabling site puts ``%APPDATA%\\Python\\PythonXY\\site-packages`` on
         sys.path BEFORE the bundle's own, so whatever the technician happens to
         have installed for their user account silently wins over what we ship.
      2. The mere PRESENCE of a ``._pth`` puts Python in isolated mode, which drops
         the script's own directory from sys.path. Analysis.py imports three flat
         siblings, so that alone breaks the tracking pipeline with
         ``ModuleNotFoundError: No module named 'export_html'``.

    Listing the paths explicitly, with site left disabled, fixes both.
    """
    pyzip = next((p.name for p in sorted(pydir.glob("python3*.zip"))), "python312.zip")
    for stale in pydir.glob("python3*._pth"):
        stale.unlink()
    _write_text(
        pydir / "python312._pth",
        "\n".join([pyzip, ".", "Lib\\site-packages", "..\\..\\tracking\\SCRIPTS", "#import site"]) + "\n",
    )


def _strip_runtime(pydir: Path):
    """Drop what the pipelines never execute: pip itself and every test suite.

    Measured on the real tree: pip is ~13 MB and the bundled test suites ~119 MB
    (pandas/tests alone dominates), for 195 MB instead of 319 MB installed. Nothing
    in either pipeline builds from source, so pip has no runtime role once the
    dependencies are in place.
    """
    site_packages = pydir / "Lib" / "site-packages"
    if not site_packages.is_dir():
        return 0
    removed = 0
    for name in ("pip", "pkg_resources", "setuptools", "wheel"):
        for target in site_packages.glob(f"{name}*"):
            shutil.rmtree(target, ignore_errors=True) if target.is_dir() else target.unlink(missing_ok=True)
            removed += 1
    for tests_dir in list(site_packages.rglob("tests")) + list(site_packages.rglob("test")):
        if tests_dir.is_dir():
            shutil.rmtree(tests_dir, ignore_errors=True)
            removed += 1
    for pycache in site_packages.rglob("__pycache__"):
        shutil.rmtree(pycache, ignore_errors=True)
    return removed


def stage_runtime(stage: Path, work: Path):
    """Download CPython embeddable and install every dependency into it.

    Runs on any host with network access — including a Linux CI runner, because
    ``pip install --target`` with the cross-platform resolver flags never executes
    the downloaded wheels.
    """
    pydir = stage / ".runtime" / "python"
    pydir.mkdir(parents=True, exist_ok=True)

    embed_zip = work / "python-embed.zip"
    _download(PY_EMBED_URL, embed_zip)
    with zipfile.ZipFile(embed_zip) as zf:
        zf.extractall(pydir)

    site_packages = pydir / "Lib" / "site-packages"
    site_packages.mkdir(parents=True, exist_ok=True)

    requirements = [pip_name for _, pip_name in DEPENDENCIES]
    print(f"[bundle] installation de {len(requirements)} dependances pour cp312/win_amd64…")
    cmd = [
        sys.executable, "-m", "pip", "install",
        "--only-binary=:all:",
        "--platform", "win_amd64",
        "--python-version", "3.12",
        "--implementation", "cp",
        "--abi", "cp312",
        "--target", str(site_packages),
        "--no-compile",
        *requirements,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout + "\n" + proc.stderr + "\n")
        raise SystemExit("[FATAL] installation des dependances echouee")

    removed = _strip_runtime(pydir)
    _write_pth(pydir)

    total = sum(p.stat().st_size for p in pydir.rglob("*") if p.is_file())
    print(f"[bundle] runtime pret : {total / 1024 / 1024:.0f} MiB sur disque "
          f"({removed} dossiers superflus retires)")


# ---------------------------------------------------------------------------
#  Manifest + archive
# ---------------------------------------------------------------------------

def write_manifest(stage: Path) -> int:
    """Write MANIFEST.sha256 in coreutils format, covering everything but .runtime/.

    RUN.bat re-hashes these with certutil before doing anything else. The runtime is
    excluded deliberately: hashing its ~3000 files in a batch loop would take minutes,
    and step 3's import check is a stronger guarantee anyway — a byte-correct but
    ABI-incompatible DLL passes a hash and fails an import.
    """
    entries = []
    for path in sorted(stage.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(stage)
        if rel.parts[0] == ".runtime" or rel.name == "MANIFEST.sha256":
            continue
        # certutil refuses a zero-byte file (ERROR_FILE_INVALID), so a single empty
        # file would make RUN.bat reject an otherwise perfect pack. Fail at build
        # time instead of shipping something that cannot pass its own check.
        if path.stat().st_size == 0:
            raise SystemExit(f"[FATAL] fichier vide dans le pack : {rel.as_posix()} — "
                             f"certutil ne sait pas le hacher, donnez-lui un contenu")
        entries.append((_sha256_file(path), rel.as_posix()))

    (stage / "MANIFEST.sha256").write_text(
        "".join(f"{digest} *{name}\n" for digest, name in entries),
        encoding="ascii", newline="\r\n",
    )
    return len(entries)


def write_zip(stage: Path, zip_path: Path):
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    root = zip_path.stem
    files = sorted(p for p in stage.rglob("*") if p.is_file())
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in files:
            arc = f"{root}/{path.relative_to(stage).as_posix()}"
            info = zipfile.ZipInfo(arc, date_time=ZIP_ENTRY_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, path.read_bytes())
    return len(files)


# ---------------------------------------------------------------------------

def build(full: bool, out_dir: Path, platform_version: str | None = None) -> Path:
    # The pack's own version (see the module docstring). Everything the operator
    # sees — the filename, the launcher banner, the admin panel — reads this one.
    pack_version = _script_version(REPO_ROOT / "preprocess" / "run_preprocess.py")
    # Traceability only. The release build passes its own: deriving it from the
    # changelog here would record the newest changelog on disk, which is NOT
    # necessarily the version being released (rebuilding an older tag, or a bump
    # landing mid-build, both misreport it).
    web_version = platform_version or _changelog_version(REPO_ROOT / "changelog")
    flavor = "complete" if full else "legere"

    brand = "Lumen3D"
    instance = REPO_ROOT / "config" / "instance.json"
    if instance.is_file():
        try:
            doc = json.loads(instance.read_text(encoding="utf-8"))
            brand = (doc.get("brand") or {}).get("short") or doc.get("brandShort") or brand
        except (ValueError, AttributeError):
            pass

    with tempfile.TemporaryDirectory(prefix="lumen-bundle-") as tmp:
        work = Path(tmp)
        stage = work / "stage"
        stage.mkdir()

        stage_sources(stage)
        if full:
            stage_runtime(stage, work)

        mapping = {
            "BRAND": brand,
            "BUNDLE_VERSION": pack_version,
            "PLATFORM_VERSION": web_version,
            "FLAVOR": flavor,
            "PY_VERSION": PY_VERSION,
            "DEPS": " ".join(pip for _, pip in DEPENDENCIES),
            "IMPORT_CHECK": "import " + ", ".join(imp for imp, _ in DEPENDENCIES),
            "BUILD_DATE": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        }
        # cmd.exe wants CRLF and an ASCII body; the template is deliberately
        # accent-free so the console codepage cannot mangle it.
        bat = _render(TEMPLATES / "RUN.bat.in", mapping)
        (stage / "RUN.bat").write_bytes(
            ("\r\n".join(bat.splitlines()) + "\r\n").encode("ascii"))

        _write_text(stage / "LISEZ-MOI.md",
                    _render(TEMPLATES / "README.md.in", mapping))

        _write_text(stage / "VERSION.json", json.dumps({
            "bundleVersion": pack_version,
            "preprocessVersion": pack_version,
            # Which web release this pack was built alongside. The servers use it to
            # tell a freshly-installed pack from one left behind by a previous
            # release (see dev_server.py:_pipeline_local) — the pack's own version
            # line is not monotonic with the platform's, so it cannot arbitrate.
            "platformVersion": web_version,
            "flavor": flavor,
            "pythonVersion": PY_VERSION if full else None,
            "dependencies": [pip for _, pip in DEPENDENCIES],
            "buildDate": mapping["BUILD_DATE"],
        }, indent=2, ensure_ascii=False) + "\n")

        _write_text(stage / "requirements.txt",
                    "# Dependances des deux pipelines (volume Imaris + tracking Excel).\n"
                    "# Generes par tools/build_pipeline_bundle.py — ne pas editer a la main.\n"
                    + "".join(f"{pip}\n" for _, pip in DEPENDENCIES))

        n_hashed = write_manifest(stage)

        suffix = "complet" if full else "leger"
        zip_path = out_dir / f"lumen3d-pipeline-{suffix}-{pack_version}.zip"
        # Leave exactly one pack per edition behind: a server picking among several
        # has to guess which one is current, and a dev checkout would otherwise
        # accumulate one per version ever built.
        for stale in out_dir.glob(f"lumen3d-pipeline-{suffix}-*.zip"):
            stale.unlink()
        n_files = write_zip(stage, zip_path)

    size_mb = zip_path.stat().st_size / 1024 / 1024
    print(f"[bundle] {zip_path.name} — {n_files} fichiers ({n_hashed} dans le manifeste), "
          f"{size_mb:.1f} MiB")
    return zip_path


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--full", action="store_true",
                        help="embarque un runtime Python complet (~70 Mo, hors-ligne)")
    parser.add_argument("--out", default=None,
                        help="dossier de sortie (defaut: assets/pipeline pour --lite, dist/ pour --full)")
    parser.add_argument("--platform-version", default=None,
                        help="version de la plateforme web associee, pour tracabilite "
                             "(defaut: le changelog le plus recent). Ne nomme PAS le pack : "
                             "celui-ci porte la version du pipeline.")
    args = parser.parse_args()

    if args.platform_version and not re.fullmatch(r"\d+\.\d+\.\d+", args.platform_version):
        sys.exit(f"[FATAL] version malformee : {args.platform_version!r} (attendu X.Y.Z)")

    out_dir = Path(args.out).resolve() if args.out else (
        REPO_ROOT / "dist" if args.full else REPO_ROOT / "assets" / "pipeline")
    out_dir.mkdir(parents=True, exist_ok=True)

    build(args.full, out_dir, args.platform_version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
