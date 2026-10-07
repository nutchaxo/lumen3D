#!/usr/bin/env python3
"""Build the operator / reader documents of DOCS/ as A4 PDFs.

Markdown (pandoc) -> one HTML page (template.html + docs.css) -> Chromium (Playwright,
print_pdf.mjs). Printed twice: the first pass tells on which page every chapter
landed (from the PDF outline Chromium writes), the second fills those page numbers
into the table of contents. Page numbers are reserved in the first pass, so the
layout of the two passes is identical.

Usage:
    python DOCS/build/build_docs.py [admin] [admin-fr] [complete] [complete-en] [essential] …  (default: all)
        "admin" builds admin-fr/en/es/nl then admin-multi (the four merged).
    python DOCS/build/build_docs.py --preview ROOT FILE.md [FILE.md …] --out OUT.pdf [--png DIR]
        ROOT = the folder image paths are relative to (DOCS/documentation, DOCS/admin-guide)

Image paths inside the Markdown are relative to the document's root folder
(DOCS/admin-guide/ for the admin guide, DOCS/documentation/ for the two others).

Needs: pandoc, node + playwright (Chromium), pypdf; pdftoppm for --png.
"""

import argparse
import html
import os
import re
import shutil
import subprocess
from datetime import date
from pathlib import Path

from pypdf import PdfReader

BUILD = Path(__file__).resolve().parent
DOCS = BUILD.parent
STAMP = date.today().strftime("%y%m%d")
DOCROOT = DOCS / "documentation"

ADMIN = DOCS / "admin-guide"
ADMIN_SOURCES = {"FR": "GUIDE-ADMINISTRATEUR.md", "EN": "GUIDE-EN.md",
                 "ES": "GUIDE-ES.md", "NL": "GUIDE-NL.md"}
FOOTERS = {
    "admin": {"FR": "Guide de l'administrateur — Lumen3D", "EN": "Administrator guide — Lumen3D",
              "ES": "Guía del administrador — Lumen3D", "NL": "Handleiding voor de beheerder — Lumen3D"},
    "complete": {"EN": "Lumen3D — Full documentation", "FR": "Lumen3D — Documentation complète"},
    "essential": {"EN": "Lumen3D — The essentials for biologists",
                  "FR": "Lumen3D — L'essentiel pour le biologiste"},
}

# One entry per published PDF. "multi" = the per-language PDFs of that document merged.
DOCUMENTS = {}
for lang, md in ADMIN_SOURCES.items():
    DOCUMENTS[f"admin-{lang.lower()}"] = {
        "root": ADMIN, "sources": [ADMIN / md],
        "outputs": [DOCS / f"{STAMP} - GUIDE-ADMIN - {lang}.pdf", ADMIN / "pdf" / f"GUIDE-ADMIN-{lang}.pdf"],
        "footer": FOOTERS["admin"][lang]}
for lang, sub in (("EN", "complete-en"), ("FR", "complete")):
    DOCUMENTS[f"complete-{lang.lower()}"] = {
        "root": DOCROOT, "sources": sorted((DOCROOT / sub).glob("*.md")),
        "outputs": [DOCS / f"{STAMP} - FULL DOCUMENTATION - {lang}.pdf"],
        "footer": FOOTERS["complete"][lang]}
for lang, md in (("EN", "ESSENTIALS-EN.md"), ("FR", "ESSENTIALS-FR.md")):
    DOCUMENTS[f"essential-{lang.lower()}"] = {
        "root": DOCROOT, "sources": [DOCROOT / md],
        "outputs": [DOCS / f"{STAMP} - ESSENTIALS - {lang}.pdf"],
        "footer": FOOTERS["essential"][lang]}
MULTI = {"admin-multi": ([f"admin-{l.lower()}" for l in ADMIN_SOURCES],
                         [DOCS / f"{STAMP} - GUIDE-ADMIN - MULTI.pdf", ADMIN / "pdf" / "GUIDE-ADMIN-MULTI.pdf"])}

PANDOC_FORMAT = ("markdown+fenced_divs+bracketed_spans+raw_html+link_attributes+implicit_figures"
                 "+pipe_tables+grid_tables+definition_lists+smart")


def run(cmd, **kw):
    print("  $", " ".join(str(c) for c in cmd[:3]), "…", flush=True)
    subprocess.run([str(c) for c in cmd], check=True, **kw)


def pandoc_html(sources, root: Path, out: Path, toc=True):
    cmd = ["pandoc", *sources, "-f", PANDOC_FORMAT, "-t", "html5", "--standalone",
           "--template", BUILD / "template.html",
           "-V", f"css={os.path.relpath(BUILD / 'docs.css', root)}", "-o", out]
    if toc:
        cmd[1 + len(sources):1 + len(sources)] = ["--toc", "--toc-depth=2"]
    run(cmd)


_TOC_LINK = re.compile(r'<a href="#([^"]+)"([^>]*)>(.*?)</a>', re.S)


def _norm(s: str) -> str:
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip().lower()


def fill_toc(page_html: str, pages: dict) -> str:
    """Wrap every TOC entry text and append its page number (or a reserved blank)."""
    start = page_html.find('<nav class="toc"')
    end = page_html.find("</nav>", start)
    if start < 0 or end < 0:
        return page_html
    used = {}

    def repl(m):
        key = _norm(m.group(3))
        seen = used.get(key, 0)
        used[key] = seen + 1
        nums = pages.get(key, [])
        num = str(nums[seen]) if seen < len(nums) else "&#8199;&#8199;&#8199;"
        return (f'<a href="#{m.group(1)}"{m.group(2)}><span class="toc-text">{m.group(3)}</span>'
                f'<span class="toc-page">{num}</span></a>')

    toc = _TOC_LINK.sub(repl, page_html[start:end])
    return page_html[:start] + toc + page_html[end:]


def outline_pages(pdf: Path) -> dict:
    reader = PdfReader(str(pdf))
    pages = {}

    def walk(items):
        for it in items:
            if isinstance(it, list):
                walk(it)
                continue
            try:
                n = reader.get_destination_page_number(it) + 1
            except Exception:
                continue
            pages.setdefault(_norm(it.title), []).append(n)

    walk(reader.outline)
    return pages


def render(sources, root: Path, pdf: Path, footer: str, toc=True):
    work = root / f".build-{pdf.stem}.html"
    pandoc_html(sources, root, work, toc=toc)
    raw = work.read_text(encoding="utf-8")
    try:
        work.write_text(fill_toc(raw, {}), encoding="utf-8")
        run(["node", BUILD / "print_pdf.mjs", work, pdf, footer])
        if toc:
            pages = outline_pages(pdf)
            work.write_text(fill_toc(raw, pages), encoding="utf-8")
            run(["node", BUILD / "print_pdf.mjs", work, pdf, footer])
    finally:
        work.unlink(missing_ok=True)
    return len(PdfReader(str(pdf)).pages)


def build(name: str):
    cfg = DOCUMENTS[name]
    sources = [s for s in cfg["sources"] if s.exists()]
    if not sources:
        print(f"[skip] {name}: no source")
        return
    print(f"[{name}] {len(sources)} source file(s)")
    tmp = cfg["root"] / f".{name}.build.pdf"
    n = render(sources, cfg["root"], tmp, cfg["footer"])
    for out in cfg["outputs"]:
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(tmp, out)
        print(f"  -> {out.relative_to(DOCS.parent)} ({n} pages)")
    tmp.unlink(missing_ok=True)


def preview(root: Path, files, out: Path, png_dir):
    out.parent.mkdir(parents=True, exist_ok=True)
    meta = BUILD / "preview-meta.md"
    n = render([meta, *files], root, out, "Aperçu", toc=False)
    print(f"  -> {out} ({n} pages)")
    if png_dir:
        png_dir = Path(png_dir)
        png_dir.mkdir(parents=True, exist_ok=True)
        for old in png_dir.glob("p-*.png"):
            old.unlink()
        subprocess.run(["pdftoppm", "-r", "55", "-png", str(out), str(png_dir / "p")], check=True)
        print(f"  -> pages rasterised in {png_dir}")


def build_multi(name: str):
    parts, outputs = MULTI[name]
    from pypdf import PdfWriter
    writer = PdfWriter()
    for part in parts:
        pdf = DOCUMENTS[part]["outputs"][0]
        if pdf.exists():
            writer.append(str(pdf))
    if not writer.pages:
        print(f"[skip] {name}: no part built")
        return
    for out in outputs:
        with open(out, "wb") as fh:
            writer.write(fh)
        print(f"  -> {out.relative_to(DOCS.parent)} ({len(writer.pages)} pages)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("docs", nargs="*")
    ap.add_argument("--preview", nargs="+", metavar="ROOT FILE")
    ap.add_argument("--out")
    ap.add_argument("--png")
    a = ap.parse_args()
    if a.preview:
        root, *files = a.preview
        preview(Path(root).resolve(), [Path(f).resolve() for f in files], Path(a.out).resolve(), a.png)
    else:
        names = a.docs or [*DOCUMENTS, *MULTI]
        for n in names:
            matches = [k for k in [*DOCUMENTS, *MULTI] if k == n or k.startswith(n + "-")]
            for k in matches:
                build_multi(k) if k in MULTI else build(k)
