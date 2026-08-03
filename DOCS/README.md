# DOCS — published operator documents

Everything at the root of this folder is served by the admin panel's
**Documentation** tab, fetched live from GitHub. Nothing here ships inside a
release: correcting a guide means dropping a new file in this folder, and every
install sees it on the next visit. No platform update, no re-deploy.

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
* **Language** — `FR`, `EN`, `NL`, `ES`… or `MULTI` for one file covering
  several. The panel opens the operator's own interface language, falls back to
  English, then to whatever exists.

Extension drives how it opens: `pdf`, `md`, `txt`, `html`, `png`, `jpg`, `svg`,
`zip`, `docx`, `xlsx`.

A file that does not match the rule is **listed as skipped** in the panel rather
than silently ignored — so a typo is visible instead of a document quietly
missing.

## Publishing

1. name the file per the rule above;
2. drop it in this folder and push;
3. it appears in the Documentation tab (the listing is cached ~10 min; the
   **Refresh** button bypasses the cache).

To publish a correction, add a file with a **newer date and the same id** — do
not delete the old one, it becomes the previous version.

## Source of these guides

The administrator guide is built from `DOCS/admin-guide/` (markdown +
screenshots per language). The PDFs published here are copies of
`DOCS/admin-guide/pdf/`, renamed to the convention.
