## [ADDED]
- **Page import / export tab**: a new admin tab (*Site public › Import / export de pages*) moves pages between sites and keeps backups. Pages are listed as cards (built-in Home / About, custom pages, and pages that only exist as a history, which can be restored); the Pages tab's Export / Import buttons now open it.
- **Page version history**: every page can keep up to 50 versions. A drop-down per page lists them, and each version can be activated (published or as a draft), renamed, annotated, exported, edited in the page editor, updated from the live page, duplicated or deleted. A chip says whether the live page is in sync with its active version or modified since. The history lives in `api/page-versions/<slug>.json` (never served, never shipped, kept across updates) and survives deleting the page, which is how a deleted page comes back.
- **Safe overwrite**: importing a page whose name already exists adds it as a new version by default and leaves the live page alone. *Replace* activates the imported version, and the server first keeps whatever the page displayed as an automatic version, so nothing is lost. A page can also be imported under another name.
- **Import verifier**: before anything is written, the file is checked and every check is listed (structure, format version, compatibility with this site, widgets, size limits, images, variables, conflicts). A file made by a newer platform than this site, a newer file format, or a page using a widget this site cannot render is refused; an unknown widget blocks only its own page.
- **Export file name**: `<site>_<page>_<ddMMyyHHmm>.json`, for example `bemine.be_about_1911261445.json` (local time). Several pages give `about+home` or `5-pages`. A whole history can be exported in one file (`lumen-pages/2`); a file with one version per page stays `lumen-pages/1` so older sites can still read it.
- **Page version API**: `api/page-versions.php` (Python and PHP twins, identical stored files) with `list`, `get`, `add`, `update`, `activate`, `delete` and `purge`; admin session and CSRF on every write, per-page lock, atomic writes. Contract in `DOCS/pages-library/SPEC.md`.

## [CHANGED]
- **Page imports no longer overwrite silently**: the former dialogs of the Pages tab are removed; every import goes through the verifier and the version history.
- **Page size limit counts slashes once on PHP**: `site_validate_page` measures a page like the Python server (raw `/`), so a page near the 2 MB limit is accepted or refused identically on both backends.

## [FIXED]
- **Version labels and notes survive a round trip**: a version's name and note are read from `lumen-pages/1` files as well, so exporting then importing keeps them.
