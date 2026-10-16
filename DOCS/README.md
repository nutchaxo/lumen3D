# DOCS — published operator documents

Everything at the root of this folder is served by the admin panel's
**Documentation** tab. The panel reads the **`main`** branch of the repository
on GitHub, through the platform's server (the browser never fetches GitHub
itself). Nothing here ships inside a release: correcting a guide means dropping
a new file in this folder and merging it into `main`. No platform update, no
re-deploy.

## Naming rule

The filename **is** the metadata. There is no index to keep in sync.

```
260803 - GUIDE-ADMIN - FR.pdf
└─┬──┘   └────┬────┘   └┬┘
  │           │         └── language
  │           └──────────── document id: stable across versions and languages
  └──────────────────────── date, YYMMDD: this is the version
```

* **Date** — `YYMMDD`. Sorts naturally, so the newest file wins and the older
  ones stay reachable under "previous versions". Real dates only: `260899` is
  rejected rather than guessed at.
* **Id** — what makes two files the same document. Keep it **stable**: change it
  and the panel treats the file as a different document. Spaces are allowed
  (`PROCEDURE INTERNE`).
* **Language** — two to six letters: `FR`, `EN`, `NL`, `ES`… or `MULTI` for one
  file covering several. The panel opens the operator's own interface language
  (or the one the operator picked), falls back to English, then to whatever
  exists.

The extension is free within one to five letters or digits. The known types are
`pdf`, `md`, `txt`, `html`, `png`, `jpg`, `jpeg`, `svg`, `zip`, `docx` and `xlsx`.
`pdf`, `png`, `jpg`, `jpeg`, `txt` and `md` open inside the panel ("Lire");
the other types are downloaded. HTML and SVG are never shown inline, since
either can carry script.

A file that does not match the rule is **listed as skipped** in the panel
(the first ten are shown) rather than silently ignored, so a typo is visible
instead of a document quietly missing. README files, dot-files and sub-folders
are not reported.

## Publishing

1. name the file per the rule above;
2. drop it in this folder, commit it on `dev`, and merge `dev` into `main`
   (the panel reads `main` only: `DOCS_BRANCH` in `dev_server.py` and
   `api/_admin_lib.php`);
3. it appears in the Documentation tab once the listing cache has expired
   (10 minutes at most, on both backends); the **Actualiser** (Refresh) button
   bypasses the cache.

To publish a correction, add a file with a **newer date and the same id** — do
not delete the old one, it becomes the previous version.

## Current contents

Page counts measured on the PDFs of this folder on 2026-10-16.

| Document | Version (YYMMDD) | Files |
|---|---|---|
| `GUIDE-ADMIN` — administrator guide | 261007 | EN 96 p, ES 97 p, FR 96 p, NL 96 p, MULTI 385 p (the four merged) |
| `ESSENTIALS` — the summary for biologists | 261008 | EN 28 p, FR 29 p |
| `FULL DOCUMENTATION` — how the whole platform works, for biologists | 261008 | EN 366 p, FR 374 p |

Previous versions of `GUIDE-ADMIN` (260803 and 260804, all five language files
of each) are kept in this folder and listed under the same document.

Sub-folders are not listed by the panel. They hold the sources and the
technical notes: `admin-guide/` (administrator guide sources), `build/` (the
PDF generator), `documentation/` (sources of the full documentation and the
essentials), `audit/`, `dataset-migrations/` (`SPEC.md`), `plugin-sandbox/`
(`SPEC.md`, `TECHNICAL.md`), `plugins/` (plugin-creation guide), `update-system/`
(`RELEASING.md`, `TECHNICAL.md`, `WALKTHROUGH.md`) and `whitelabel/` (`PLAN.md`).
`bemine-pages/` is listed in `.gitignore` and is local to one machine.

## Source of these documents

All PDFs are built by `DOCS/build/build_docs.py` (Markdown → HTML → Chromium; writing rules in
`DOCS/build/STYLE.md`):

| Document | Languages | Sources |
|---|---|---|
| `GUIDE-ADMIN` — administrator guide | FR, EN, ES, NL, MULTI | `DOCS/admin-guide/`: `GUIDE-ADMINISTRATEUR.md` (FR), `GUIDE-EN.md`, `GUIDE-ES.md`, `GUIDE-NL.md`; MULTI merges the four |
| `FULL DOCUMENTATION` — how the whole platform works, for biologists | EN, FR | `DOCS/documentation/complete-en/` (EN), `DOCS/documentation/complete/` (FR): chapters `00-front.md` to `21-glossaire.md` |
| `ESSENTIALS` — the summary for biologists | EN, FR | `DOCS/documentation/ESSENTIALS-EN.md`, `DOCS/documentation/ESSENTIALS-FR.md` |

```
python DOCS/build/build_docs.py                 # everything
python DOCS/build/build_docs.py admin complete-en essential-fr   # a selection
```

Targets: `admin` (the four languages, then `admin-multi`), `admin-fr`, `admin-en`,
`admin-es`, `admin-nl`, `complete`, `complete-en`, `complete-fr`, `essential`,
`essential-en`, `essential-fr`. A name selects every target that starts with it.
Each output is named with the **build date** (`YYMMDD` of the day the PDF was
built), so a rebuild is a new version. The build needs pandoc, Node with
Playwright (Chromium) and pypdf; `pdftoppm` is needed for `--png`.

## Admin guide copies (historical note)

An admin build writes two files: the dated PDF in this folder and an undated
copy in `DOCS/admin-guide/pdf/GUIDE-ADMIN-<LANG>.pdf`. The panel lists only the
dated files at the root of this folder.
