# 18. Hosting, updating and releasing a version

::: chapter-intro
- Lumen3D can be served by **three kinds of server** (Python, PHP, or plain files). This chapter says what each can do, how it answers the browser and why the pages stay fast.
- An **update** is a **signed** package: the platform refuses anything it cannot prove authentic, then switches over while keeping a way back (on Python).
- Every release is **fully tested** (201 test files), signed, then published in one go. The platform works **without Internet**.
:::

This chapter is for the person who **installs and maintains** the site: the administrator, or the IT person who helps them. Chapters 9 to 12 explain what the visitor sees; this one explains **the machine behind it**.

Nothing here requires writing code. But understanding these mechanisms lets you **diagnose** a slow site, a refused update or a temperamental host.

::: note
The version numbers quoted are those of this document: web platform **1.59.3**, pipeline **0.21.0**, data format **4**. The administration panel in brief is in chapter 14; security in general is in chapter 19.
:::

## 18.1 Three ways to serve Lumen3D

The browser always speaks the same language (HTTP). What changes is **the program that answers** on the other side. There are three families.

![What each way of serving can do: from the most complete to the simplest.](img-en/ch18/trois-serveurs.svg){width=76%}

::: analogy
**A library desk.** The full desk (Python or PHP) checks your card, finds the book and keeps the loan register. A simple self-service shelf (static host) lets you take a book, but keeps no register and checks nobody.
:::

- **`dev_server.py`**: the Python server. It does **everything** (pages, catalogue, administration, import, update). It is the recommended server.
- **`fast_server.py`**: the same server, **read-only**. It answers a visitor exactly like `dev_server.py`, but **every administration route is refused** (404). It is used to measure performance.
- **PHP** (folder `api/`, `router.php`, `_serve.php`, `.htaccess`): for university hosts that offer PHP but not Python. Same functions, same files, same password.
- **"Files only" host**: fine for viewing, but with no administration, no generated catalogue and none of the nonce protection of chapter 19.

### Which one to choose?

![The decision tree for a hosting choice.](img-en/ch18/hebergement.svg){width=100%}

::: example
**A laboratory with a dedicated computer.** It runs `python dev_server.py --dev-trust-local`: a single command, nothing to install, updates with rollback. **A university that offers only PHP**: it drops in `install.php` (§18.14); Apache reads the supplied `.htaccess` file, which routes the pages to `_serve.php`.
:::

::: tech
**`dev_server.py` options**: `--host` (default `localhost`), `--port` (default `8080`), `--set-password` (change the administrator password from the command line), `--check` (validate an installation without opening a port, §18.10), `--root` (the installation to check), `--dev-trust-local` (trust local plugins; **reserved for the development machine**), `--trusted-proxy` (§18.6), `--migrate-types`, `--verbose` (log every request). By default no request is written to the console: a synchronous write per request would slow the answers.

**Minimum versions**: Python 3.10 (the README says so); PHP 8.1, the version tested by continuous integration, with the `zip`, `mbstring`, `sodium` and `gd` extensions. The `install.php` installer itself needs only PHP 7.4 to start.
:::

## 18.2 The path of a request

A visitor asks for an address. The Python server sorts the request into **one of the six categories** below, in this order. As soon as one fits, it stops.

![The six destinations of a GET request on the Python server.](img-en/ch18/chemin-requete.svg){width=86%}

- The **catalogue** and the **probes** are fabricated answers, never files.
- **Forbidden** paths get a 404, **even if the file exists**: the server does not confirm it is there.
- `.html` pages go through a separate treatment: a fresh secret code (the "nonce") is inserted into every page at every load (chapter 19).
- Everything else is a **static file**: bricks, scripts, images.

### The catalogue is not a file

The address `DATA_WEB/catalog.json` **does not exist on disk**. The server fabricates it on demand by reading the `metadata.json` cards of each folder of `DATA_WEB/3d`, `2d` and `live`.

- Datasets that are **configured or have a thumbnail**, and are **not hidden**, are listed.
- Sorted by descending date; a dataset with no date goes **last**.
- The result is cached, with a fingerprint (ETag); the list is recomputed only if a card has changed (the disk is consulted at most once every 2 seconds).

::: example
**Adding a dataset by hand.** You copy a finished folder into `DATA_WEB/3d/`: on the next visit it appears in the Explorer. Nothing to regenerate. On a PHP host, `api/catalog.php` does the same job, called by a rewrite rule in `.htaccess`.
:::

::: tech
**On Apache, rewriting is essential**: without the `mod_rewrite` module, the catalogue address answers 404 and HTML pages come out without nonce protection. The supplied `.htaccess` file wraps each directive in `<IfModule …>`, because a directive from a module that is not loaded would bring **the whole site** down with a 500 error. It never uses `Options` (which requires a right many shared hosts do not grant): folder listings are refused by a rewrite rule.
:::

### The health probe

The address `/api/health` answers one minimal line of JSON: `{ok, web, server, trustEpoch}` (and `lastUpdate` just after an update). It is **public** and says only what is already public (the version on GitHub).

It serves two purposes: the update supervisor (§18.11) queries it to know whether the new version is alive, and you can hand it to a monitoring tool. **PHP hosts do not have this probe.**

## 18.3 HTTP caching: never re-download for nothing

A dataset weighs gigabytes; the platform, about thirty scripts. Without a cache, every visit would start from zero. The server therefore tells the browser **how long to keep** each file.

::: analogy
**The fridge and the label.** A yoghurt carries a date: until that date, no need to ask the shop again. A morning newspaper, though, must be **rechecked**: "is this still today's?". The HTTP cache is that system of labels.
:::

![The decision table: one rule per file type, depending on whether a ?v= is present.](img-en/ch18/cache.svg){width=88%}

### Three rules to remember

::: steps
1. **A "versioned" address never changes content.** If it carries `?v=…`, the browser keeps it without asking again: **1 year** for a brick pack, **7 days** for a script or a style.
2. **Everything else is "no-cache + ETag".** The browser keeps the file but **asks again** with the fingerprint it holds; the server answers "304, unchanged" **without resending the bytes**.
3. **An HTML page is never kept** (`no-store`): its secret code changes at every load.
:::

### Where does `?v=` come from?

- **Brick packs**: the loader (chapter 10) adds `?v=` followed by a fingerprint of the manifest's **list of packs**. Reprocessing a dataset under the same name changes the packs, hence **the addresses**: old voxels can never be re-read by mistake.
- **Scripts and styles**: when a release is built, the build tool adds `?v=<version number>` to every local link, and gathers a page's scripts into **a single file** (`js/bundle/<page>.js?v=<fingerprint>`).
- **The theme** (`config/theme.css`): its `?v=` is the file's last modification date, so that a colour change appears **immediately** despite the cache.

::: why
**Why such care for a script?** Some hosts limit the number of requests per address: thirty scripts re-requested on every page can trigger a 429 error ("too many requests") and stop the viewer from starting. Versioned addresses avoid those re-requests.
:::

### What a browser sees, from one visit to the next

![First visit, then later visits: what is asked again.](img-en/ch18/chargement.svg){width=100%}

Here are answers **actually measured** on the demonstration Python server (synthetic dataset):

| Request | `Cache-Control` | Remark |
|---|---|---|
| `viewer.html` | `no-store` | page + fresh nonce |
| `js/core/utils.js` | `no-cache` | ETag `…-gz` (compressed version) |
| `js/core/utils.js?v=1.59.3` | `public, max-age=604800, immutable` | 7 days |
| `…/bricks/manifest.json` | `no-cache` | gzip: 1,151 bytes |
| `…/p00000.bin` | `no-cache` | 1,383,748 bytes |
| `…/p00000.bin?v=abc` | `public, max-age=31536000, immutable` | 1 year |
| `/api/health` | `no-store, no-cache, must-revalidate` | 66 bytes |

::: warning
**Without `?v=`, a pack is revalidated, not kept for a year.** A long lifetime on an address that nothing changes would have served the **old voxels** after a reprocessing: a silent scientific error. That is why the "1 year" rule demands proof (`?v=`) that the address is new.
:::

::: tech
**Both backends apply the same table**, in `dev_server.py` (`_static_cache_policy`) and in the root `.htaccess` (environment variables set by `mod_rewrite` when the request contains `v=`). A test compares the two (`tests/test_backend2_twins_parity.php`).

**One difference to know for images and fonts**: the Python server answers them `no-cache` + ETag; Apache, through the `.htaccess`, gives them 7 days. The Python ETag is made of the modification date and the size (`"18dc4a43bc302352-4a17-gz"`: the `-gz` suffix marks the compressed version).
:::

## 18.4 Compression and byte ranges

### gzip: lighter text files

A brick manifest can weigh tens of MB of JSON: compressed, it weighs seven times less. The server therefore compresses **text** files on the fly: `.json`, `.js`, `.mjs`, `.css`, `.svg`, `.txt`, `.csv`, `.md`.

- Threshold: at least **1 KiB** (and at most 256 MiB); level 6.
- The result is **cached** (96 MiB budget) and redone only if the file changes.
- No compression when the browser asks for a byte **range**, nor for `download/` files (which always go out as attachments).
- **Brick packs are never compressed**: they are already WebP images.

On Apache, compression is handled by the `mod_deflate` module (JSON, HTML, CSS, JS, SVG), still not for packs.

### Byte ranges: asking for just a piece

To display a **cut** of the volume, the viewer does not need a whole 16 MiB pack: it asks for just a few stretches (chapter 10). The browser then writes a `Range: bytes=…` header.

![One range, several ranges, an absurd range: the server's answers.](img-en/ch18/ranges.svg){width=100%}

::: analogy
**Photocopying a few pages of a book.** Rather than carrying off the whole volume, you ask for "pages 1 to 3 and 200 to 210". The server answers with exactly those pages, each labelled with its position in the book.
:::

The Python server handles the **three cases** of the HTTP standard (RFC 9110):

- **One range**: a `206` answer with `Content-Range: bytes 0-99/1383748`. A "last N bytes" range (`bytes=-N`) is understood.
- **Several ranges** (`bytes=0-99, 500-599`): a single `206` answer of type `multipart/byteranges`, **one round trip** instead of two. Ranges that touch are merged; beyond **64 distinct ranges** (or if the header is malformed), the server returns the **whole file** (`200`), which the standard allows.
- **A range outside the file**: `416` with `Content-Range: bytes */<size>`.

::: example
**Checked on the demonstration dataset.** On a pack of 1,383,748 bytes: `bytes=0-99` answers `206` with 100 bytes; `bytes=0-99, 500-599` answers `206 multipart/byteranges` with 473 bytes in total (two times 100 bytes, plus the part headers); `bytes=99999999-` answers `416`.
:::

::: tech
`If-Range` is honoured (a range is served only if the ETag or the date still match). Range requests do **not** count as a download in the statistics. On the Apache side, the HTTP server handles ranges itself, with its own limits (`MaxRanges`). The brick loader, for its part, has a per-host **fallback** for when multiple ranges are not understood (chapter 10).
:::

## 18.5 Closed folders and guard files

A website serves files; but not all of them should go out. Passwords, signing seeds and unvalidated imports **must never** be downloadable.

![Which folders are served, which are always refused.](img-en/ch18/dossiers.svg){width=100%}

::: analogy
**The doors of a public building.** The lobby is open to everyone; the offices are locked; the archive room has **several different locks**, so that forgetting one does not let anyone in.
:::

### Four locks for `uploads/`

The imported bytes (chapter 14) are not yet validated. Four **independent** barriers protect them: the Python server's list of forbidden roots, the root `.htaccess`, the `router.php` router, and a "deny all" `.htaccess` written inside the folder itself. The preview of a dataset being imported goes through an API address that requires the administrator session.

### The "lumen-guard v2" guard files

Two served folders (`DATA_WEB/` and `js/`) receive an `.htaccess` that **forbids script execution**: even if someone drops a malicious `.php` there, it will not run. `uploads/` and the media library have their own guard.

Each guard carries the mark `lumen-guard v2`. The server **rewrites** a guard only if that mark is missing: the two servers (Python and PHP) therefore never fight over the same file for a stray space.

::: why
**Why does `DATA_WEB/` need a guard?** Because this folder is at once **served** to the public and **open for writing** by the operator (by FTP or by the import). A booby-trapped file there would be the ideal way in. The guard is rewritten at run time: an update never delivers it (`DATA_WEB` escapes updates, §18.13).
:::

::: tech
**PHP router details.** `router.php` (for `php -S`) refuses every `api/*.json` and `api/_*.php`, the folders `secrets/ logs/ backups/ uploads/ .git`, any name starting with a dot (except `.well-known`) and `*.lumen-old|new|backup`. It computes the path **without** `parse_url()`: an address starting with two slashes (`//api/admin_credential.json`) makes `parse_url()` read "api" as a host name, and the password file used to come out with a `200`. The path is therefore split by hand, decoded, normalised, then compared with the rules. Files parked by an update (`*.lumen-old`) would be served as text and would publish the old code: hence their prohibition.

**File permissions.** Files created by the server inherit the **rights of the root folder**: `0770/0660` on a shared host where the web server and your FTP account share a group, `0755/0644` elsewhere. If the server runs under a different user from the owner, group write rights are added so that the owner keeps control (FTP, deletion). Override: `LUMEN_DIR_MODE` and `LUMEN_FILE_MODE` (octal values). The secrets in `api/` keep restrictive rights.
:::

## 18.6 Behind a proxy, rate limits and the session lock

### The reverse proxy and the visitor's address

Many institutes put a **reverse proxy** (Nginx, Apache…) in front of the server: it handles HTTPS and forwards requests. The problem: Lumen3D now sees only **the proxy's address**.

![Without a declaration, all visitors share the proxy's address and a single login counter.](img-en/ch18/proxy.svg){width=100%}

- **Declare the proxy**: `--trusted-proxy 10.0.0.2` (repeatable option, addresses or networks), the variable `LUMEN_TRUSTED_PROXIES="ip,network"`, or the file `api/trusted-proxies.json` (`{"proxies":[…]}`), which **both servers** read.
- **Why read the list from the right?** Each proxy **appends** the address it sees. Everything on the left may have been written by the visitor: it is not trusted.
- **Secure cookie**: the session gets the `Secure` attribute if a declared proxy announces HTTPS (`X-Forwarded-Proto`), or if `LUMEN_COOKIE_SECURE=1` forces it.

### Rate limits

| Where | Limit | What for |
|---|---|---|
| Admin login | 10 failures / 15 min / address, global ceiling of 200 | counter mass guessing |
| Public counters (`telemetry`) | token bucket: 60 in reserve then 1/s per address; 600 then 20/s for everyone; GET refused | prevent inflating the statistics |
| Import, data updates | the browser's governor (chapter 17) | avoid getting the operator's address banned |
| GitHub (admin) | answer cached for 5 minutes | 60 requests/hour per address without an account |

### The PHP session lock

On PHP, **a session is a file that is locked** as long as a request is using it. Two requests from the same administrator **queue up**. Now the *Updates* tab fires three checks towards GitHub: the *Datasets* tab used to wait behind them.

![Before: requests queue up. Now: the session is read then released.](img-en/ch18/verrou-session.svg){width=100%}

::: remember
**Rule of the code**: every entry point that only **reads** the session releases it at once (`session_write_close()`). Only the login keeps it, because it writes it. A new PHP entry point must follow the same rule.
:::

## 18.7 Running a server day to day

| Need | Where to look |
|---|---|
| Is the site answering? | `/api/health` (Python) |
| Server logs | `logs/` folder (the server restarted by an update writes `dev-server-<timestamp>.log`) |
| An update failed | `logs/update-pivot-*.log`, `backups/pivot-journal.json`, `backups/last-update.json` |
| Backups before an update | `backups/backup-<version>-<date>.zip` (the 3 most recent) |
| Change the password | the *Security* tab, or `python dev_server.py --set-password` |
| Validate an installation | `python dev_server.py --check` |

::: tip
**Before tinkering, run `--check`.** This command checks, without opening a port, that the essential files are there, that `dev_server.py` compiles, that the language files are readable and that the version is consistent. Exit code 0 = all is well; 1 = a problem (a JSON report says which).
:::

## 18.8 Updating the platform: the principle

An update is started from [System › Updates]{.ui}. The administrator sees the state, clicks, and the platform does the rest.

![The Updates tab of the administration panel (demonstration dataset, up to date).](img-en/ch18/maj-onglet.png){.shot width=100%}

::: legend
| n | what it is |
|---|---|
| 1 | [Installed versions]{.ui}: web platform and preprocessing pipeline |
| 2 | [GitHub update]{.ui}: "You are up to date", or the available update |
| 3 | [Plugin updates]{.ui} |
| 4 | [Processing pack]{.ui}: the data-preparation software |
| 5 | [Check]{.ui}: asks GitHub for the state again |
:::

### Four numbers, four roles

![The version numbers you will come across.](img-en/ch18/versions.svg){width=100%}

- The **platform** has **no** version constant: it is the **name of the most recent changelog file** (`changelog_1.59.3.md`). Releasing = creating that file.
- The **Python server** has its own version (`0.16.0`), which **deliberately drifts**: it tracks the server tool, not the platform.
- The **pipeline** (0.21.0) is another piece of software, installed on the processing computer.

### How the platform learns that a version exists

1. It queries GitHub: `releases/latest` of the platform's repository (hard-coded, never typed in by the user). The answer is **kept for 5 minutes**.
2. It compares with its own version. If the most recent is strictly greater, an update is **available**.
3. It looks for **exactly** the elements it needs in the GitHub release.

::: tldr
Elements of a release: `lumen3d-web-<version>.zip` (the platform), `SHA256SUMS` (the list of fingerprints), `SHA256SUMS.sig` (the signature of that list), `lumen3d-release-notes.json` (all the release notes), and the **processing packs** named after the **pipeline's** version.
:::

::: tech
**The pack name carries the pipeline version**, which lets the *Pipeline* tab compare the installed pack with the published one **without downloading anything**, and so offer a pipeline update without a platform update.

**Release notes**: each release embeds the changelogs of **all** versions (the flat level of `changelog/`, not the archive). A site several versions behind thus reads the notes of each version it is about to absorb, without calling GitHub once per version. Rendering: a foldable tree per version (bold title of each entry), also available as a stand-alone page (`admpan.html?changelog=1`).

**GitHub's limit**: without an account, 60 requests per hour per address. Behind a university NAT it runs out quickly: the panel then shows "too many requests" with the delay, instead of a misleading "403".
:::

## 18.9 The signature: proving a package is authentic

A package that arrives over the Internet could have been **replaced on the way**. Lumen3D therefore installs nothing it cannot prove: the archive must match a list of fingerprints, and that list must carry the publisher's signature.

::: analogy
**A wax seal on a letter.** Only the publisher owns the seal (the private key). Anyone can **check** that a letter carries it (the public key, known to your server), but nobody can make a fake one.
:::

![The chain: list of fingerprints, Ed25519 signature, pinned public key, then extraction.](img-en/ch18/signatures.svg){width=100%}

### Two checks, in this order

::: steps
1. **The signature** (Ed25519 algorithm) is verified on the **exact bytes** of `SHA256SUMS`, with the public key your server already knows.
2. **The archive's SHA-256 fingerprint**, recomputed, must equal **its line** in `SHA256SUMS`. An archive missing from the list is refused.
:::

The word "**fail-closed**" sums up the rule: at the slightest doubt, the door stays shut. The update **stops** and shows the reason. Without a valid signature, nothing is installed.

### Where does the public key live?

In **three constants**, which must be identical: the Python server (`_RELEASE_PUBKEY_HEX`), the installer (`install.php`) and the PHP administration code (`LUMEN_RELEASE_PUBKEY`). The **private** key exists only in GitHub's `LUMEN_SIGNING_KEY` secret.

::: warning
**Why the key is "in the code" and not "in the package".** A key delivered with the package would be the forger's. The pinned key is therefore placed in the repository's **source code**, and travels in every release. A server accepts only the key it knows.
:::

::: tech
**Changing the key (rotation).** The release that **introduces** the new key must still be signed with the **old** one: the server verifies it with the key it knows, then installs the code that pins the new one. Only the following releases are signed with the new key. The tool `tools/gen_signing_key.py` prints a key pair (it writes nothing to disk). **The plugin catalogue has its own key pair** (chapter 15): never the same seed for both.

**On PHP**, the signature is verified by the **libsodium** library (`sodium_crypto_sign_verify_detached`); on Python, by an Ed25519 verifier written in pure Python (`ed25519_pure.py`, RFC 8032), which needs nothing beyond the standard library. A key left empty would downgrade verification to "SHA-256 only" with a warning; the key is set today.
:::

## 18.10 Updating on a Python server: eight steps

As long as the server has not switched over, **the running installation is not touched**. The update runs in a thread of the **live** server, which keeps answering visitors.

![Eight steps; only the last one modifies the site.](img-en/ch18/maj-chaine.svg){width=100%}

| Step | What is done | What stops it |
|---|---|---|
| 1 Checks | same volume, free space ≥ max(3 × the archive, 300 MB), `backups/` writable | a previous switch-over not reconciled |
| 2 Backup | zip of everything the release manages (protected paths, §18.13, are excluded); re-read after writing | an unreadable file: the backup **aborts** |
| 3 Download | size compared with the announced one | truncated archive |
| 4 Authenticity | signature then SHA-256 (§18.9); archive intact (`testzip`) | any doubt |
| 5 Preparation | safe extraction into a separate folder | suspicious entry (see below) |
| 6 Dry start | `dev_server.py --check` **on the new tree** | an essential file is missing |
| 7 Plan + journal | list of files to put in place and to remove, written to disk | — |
| 8 Switch-over | a detached supervisor takes over (§18.11) | — |

::: warning
**A release that contains `api/plugin-trust.json` is refused.** This file lists the plugins the operator has approved: a malicious release could otherwise **pre-approve** a booby-trapped plugin. Likewise, the staged release must carry **exactly** the announced version, and every file must match the fingerprint recorded in its `version.json`.
:::

::: tech
**Safe extraction.** Every entry of the archive is checked before extraction: an absolute path, a drive letter, a backslash or `..` are refused (an archive received from the Internet is untrusted input). A clean-up keeps the **3** most recent backups and deletes stale temporary folders.

**Four approaches were compared** at design time (in-place journal, git checkout, permanent supervisor, swap by preparation): the last was chosen because **the site is touched only by renames**, never by an in-place copy. An interruption half-way would otherwise leave a half-old, half-new tree that could not start.
:::

## 18.11 The switch-over and the way back

The server that prepared the update cannot replace itself: its files are **in use**. It therefore launches a **supervisor**: a **copy** of `dev_server.py`, placed in a private temporary folder, which holds no file of the installation.

![The switch-over, step by step, with its rollback branch.](img-en/ch18/pivot.svg){width=100%}

::: analogy
**The blue-green move.** You set up the new flat next to the old one, check that the water and electricity work, and only then move in. If something is wrong, you go back to the old one, which stayed intact.
:::

### The five beats

1. The current server **stops listening** (one second after letting the answers in progress go out).
2. The supervisor waits for **the port to be freed** (30 s at most).
3. It **swaps** the files by **renames**, each noted in the journal. No byte is copied: everything is almost instantaneous.
4. It **starts the new server**.
5. It **queries `/api/health`** every half second for 30 s. Success = the probe answers with **the target version**.

### If the probe fails

The supervisor stops the new server, marks the journal "rolling_back" **before** acting, applies the renames **in reverse**, restarts the old server and probes it in turn. The panel then shows: "The new version did not start — automatic restoration done. The old version is working."

::: example
**A two-step rename.** To replace `viewer.html`: the old one goes into a mirror folder (`old/`), then the new one takes its place. At each step the supervisor **looks at the disk** (not at its memory): if it is interrupted and restarted, it resumes **exactly** where it stopped. The rollback is safe from **any** intermediate state.
:::

### And if the supervisor dies too?

At the next start-up, the server finds the **journal**. It moves forward only if **everything** is proven: phase "applied" or "done", version equal to the target **and** every file with the right fingerprint. In **every** other case, it goes back. The version alone is not enough to conclude: it is only one file among thousands.

::: tech
**Windows details** that shaped the design: a server process locks its working folder (the supervisor runs from the temporary folder); antivirus programs place transient locks on fresh files (the rename is retried up to 10 times); the server is restarted as a **detached** process. A listening address of `0.0.0.0` cannot be reached: the probe uses `127.0.0.1`. Otherwise every update on `--host 0.0.0.0` would have been wrongly cancelled.

**Tracking files**: `backups/pivot-journal.json` (phases `planned` → `applying` → `applied` → `done`; or `rolling_back`), `logs/update-pivot-<timestamp>.log`, and `backups/last-update.json`, the "last result" the panel reads after the restart (`done` or `rolled_back`). The tests `tests/test_update_pivot.py` and `tests/test_update_reconcile.py` cover full application, restoration, replay after a partial crash and the double rollback.
:::

## 18.12 Updating on PHP hosting

A PHP host **also updates itself**, but differently: PHP has no continuously running server, so there is nothing to restart. Everything happens in **a single request**, from click to answer.

![The two ways of updating, side by side.](img-en/ch18/deux-mises-a-jour.svg){width=100%}

::: warning
**No automatic rollback on PHP.** A PHP update that fails half-way does not "undo" itself. It is designed so that **you can simply run it again**: the copy is idempotent, and the release notes (`changelog/`) are copied **last**, so that a failure leaves the **old** version declared and a new attempt is allowed.
:::

### How it runs

1. **Lock**: one update at a time (a second click gets "update in progress").
2. **Target version**: same search as on Python; only the archive named `lumen3d-web-<version>.zip` is accepted.
3. **Authenticity**: same double check (libsodium signature, SHA-256).
4. **Extraction** into a working folder **under the site root** (same disk: a rename there is instantaneous; outside the site, it failed on some shared hosts).
5. **Archive checks**: at most 5,000 entries, 128 MiB uncompressed, no suspicious path (`..`, `.`, empty, backslash, drive).
6. **Putting files in place**: each old file is **parked** (`.lumen-old`) then replaced; protected paths are skipped (§18.13).
7. **Tidying**: old files removed, PHP code cache (opcache) invalidated so that the **new** version answers from the next request.

### Special cases

- **Busy file** (Windows): the new file is parked as `.lumen-new` and finished in a later request.
- **Root `.htaccess`**: the `LUMEN3D` block is **rewritten**, but **your lines** (`AddHandler`, `RewriteBase`, `php_value`…) are kept, and a `.lumen-backup` copy is preserved. Without this, an update could make PHP be served **as text**.
- **Removed files**: on PHP, only a short list is deleted (`api/config.php`, an old file that held a password hash). There is no comparison of the `version.json` files.

::: tech
The execution time is extended to 600 s. The Python-only files (`dev_server.py`, `fast_server.py`, `ed25519_pure.py`, `start.bat`) are **skipped** on a PHP host. The `js/modules/` folder is never overwritten (an installed plugin is not part of the release).
:::

## 18.13 What an update never touches

A release **replaces the code**, never **your data or your work**.

![On the left what is untouchable, on the right what the update replaces.](img-en/ch18/protege.svg){width=100%}

- The list of protected paths is in `_UPDATE_PROTECT` (Python) and `admin_update_protected()` (PHP). The two are **twins**.
- In `config/`, only the files the operator edits are protected; `config/defaults/` is part of the release and **stays** updated.
- **Deletions** are computed on Python by the difference between the two `version.json` files (old and new): a file shipped before but not any more is deleted; **a file unknown to both** (that you added) is never touched.

### Plugins during an update

Before switching over, the *Updates* tab runs a **pre-flight**: it asks which installed plugins would be **incompatible** with the target version (each plugin's `platformCompat` field, chapter 15).

- An incompatible plugin is **set aside** ("quarantine") after the switch-over, not deleted: its folder stays in place.
- As soon as an update of the plugin, or of the platform, makes it compatible, it is **re-enabled automatically** at the next discovery.
- Only one case **blocks** the update: if **no render mode at all** would remain available (the viewer could no longer display anything).

::: remember
**A crashing plugin never brings the viewer down.** The registry isolates each plugin (a try/catch per plugin, plus a global barrier): the 3D canvas always starts, even if the whole plugin subsystem fails.
:::

## 18.14 First installation: `install.php`

For an empty host, **a single file** is enough: you drop `install.php` into an empty web folder and open it in a browser.

![The six steps of the installer.](img-en/ch18/installeur.svg){width=100%}

- It downloads **the latest release** of the platform's repository, **verifies** the signature and the fingerprint (§18.9), extracts, then asks you to create the **administrator account** (8 characters minimum).
- The download is done **in slices** (8 MiB or 10 s) with resume, to survive the time limits of shared hosts. Extraction is done in batches of 200 entries.
- At the end, it writes `.install-lock` and **offers to delete itself**. If it finds an administrator account or this lock, it **refuses to run**: it cannot be replayed to overwrite a live site.

::: tech
Extra safeguards: GitHub repository **hard-coded** (no address is typed in); every archive entry checked (no traversal, symbolic link or absolute path); **zip bombs** bounded (20,000 entries, 500 MB uncompressed, archive ≤ 512 MB); `install.php` never overwrites itself; anti-forgery token on every request; state in `.install-state.json` (no secret, deleted at the end). The account file is created with **exclusive creation** and in the same format as that of the two servers.
:::

## 18.15 Releasing a version (for the publisher)

This section describes the chain on the **publisher's** side: the person who evolves the platform. It shows why the version that reaches you has a good chance of being correct.

![From idea to your server: the whole path of a release.](img-en/ch18/release-pipeline.svg){width=100%}

::: steps
1. **Write the changelog.** Create `changelog/changelog_X.Y.Z.md`: **it is the version number**. Sections `[ADDED]`, `[OPTIMIZED]`, `[FIXED]`, `[CHANGED]`; one entry per bullet, `- **Short title**: what changes and why`. The administration panel shows only the bold title in folded mode.
2. **Check locally**: `python tests/run_all.py -j 4`, `python tools/check_version.py --tag vX.Y.Z`, `python dev_server.py --check`.
3. **Tag**: `python tools/make_release.py` (or `--dry-run` to simulate). It checks the changelog, refuses a dirty tree or any branch other than `main`, sets the `vX.Y.Z` tag and **pushes the tag**.
4. **CI takes over**: it publishes only if **everything** passes (§18.16).
:::

### What the "release" job does

- **Refusal without a key**: without the `LUMEN_SIGNING_KEY` secret, it stops: never an unsigned release.
- **Processing packs**: the full pack is built **before** the zip, so that its fingerprint appears in the signed list. The light pack is copied from the tree.
- **"Curated" zip**: built from a **whitelist** of files (anything not on it is excluded, so documentation, tools or data never leak by accident). Fixed timestamp: two builds give the same bytes.
- **Signature** of `SHA256SUMS`, then **re-verification** against the key pinned in the code: a release that servers would refuse is itself refused.
- **Publication in three stages**: the release is created as a **draft**, receives **all** its files, **then** is published. A site that asks for "the latest release" therefore never sees a release without its zip.

::: why
**Why does CI create the release, and not `make_release.py`?** A release created by hand would first appear **without files**: the updater would then fall back on GitHub's automatic "source" zip, which **cannot be verified**. Creation is therefore left to CI.
:::

### Two other forms of publication

| | Platform | Platform plugin | Third-party plugin |
|---|---|---|---|
| Version | new `changelog_X.Y.Z.md` | `plugin.json` → `version` | same (informative) |
| Publish | `make_release.py` → CI | `publish_plugin.py <folder> --push` | drop the folder in |
| Apply | admin → Updates | admin → Catalog | approve (fingerprint) |
| Signature | Ed25519 of the release | Ed25519 of the catalogue (another key) | out of scope |

Platform plugins do **not** ship with the release: they are published in the **signed catalogue** and installed on demand (chapter 15). Their publication takes effect when `dev` is merged into `main`, because the catalogue is read from `main`.

## 18.16 The test suite: what guards the door

A release is signed **only if** the test suite is entirely green. This suite is launched by **a single command**.

![201 test files, three languages.](img-en/ch18/tests.svg){width=100%}

::::: keynums
::: keynum
**201**
test files
:::
::: keynum
**124**
Node (viewer, workers, protocols)
:::
::: keynum
**55**
Python (server, pipeline, import)
:::
::: keynum
**22**
PHP (twin server)
:::
:::::

- `python tests/run_all.py` discovers every `tests/test_*.py|js|php` and `tests/js/test_*.mjs` file, and runs **each in its own process**.
- **`--strict-skips`**: a test that cannot run (a missing PHP extension) must say so, and this mode counts it as a **failure**. A test therefore cannot stop running without anybody noticing.
- **`--check-clean`**: a test that **dirties the repository** (a file created or modified) fails. Everything must happen in temporary folders.

::: why
**Why test the "twins" with the same vectors?** Several rules exist in **two or three languages** (version compatibility, trust fingerprint, import, release notes). The same file of cases is played by Python, PHP and JavaScript: if they diverge, a test fails. For example, `tests/compat-vector.json` contains 42 cases.
:::

### Continuous integration, at every change

Two GitHub workflows: **`ci.yml`** (at every code push to `main` or `dev`, and for any merge request) and **`release.yml`** (at every `v*` tag). They chain:

| Check | What it guarantees |
|---|---|
| `check_version.py` | the tag equals the most recent changelog; no duplicate or badly named file |
| `dev_server.py --check` | a fresh installation starts dry |
| full suite | no behaviour has degraded |
| no `allow-same-origin` | a plugin sandbox never loses its isolation |
| no `eval()` / `new Function()` | the code stays compatible with the strict security policy |
| no `<script src="http…">` | no library comes from the Internet |

## 18.17 Working without Internet

Lumen3D was designed for a **closed network**. Everything the **visitor** needs is in the site's folder.

![What works offline, and what needs Internet.](img-en/ch18/hors-ligne.svg){width=100%}

| Library | Version | File |
|---|---|---|
| Three.js | 0.147.0 | `js/vendor/three.min.js` (+ GLTF and OrbitControls loaders) |
| Lucide | 0.344.0 | `js/vendor/lucide.min.js` |
| Plotly | 2.27.0 | `js/vendor/plotly.min.js` (loaded only when a chart is opened) |

- Each library is checked by an **integrity fingerprint (SRI)**: if a single byte changes, the browser refuses it. The `js/vendor/` folder is protected from line-ending conversions so that the fingerprint stays valid.
- The security policy allows **no foreign script**: adding a `<script src="https://…">` tag would break the page, and continuous integration refuses it.
- **The only visitor-side exception**: fonts (Google Fonts). They are declared to load **in the background**: on a network that filters them, the page displays at once with the system fonts.
- **On the administrator side**: GitHub is contacted only to look for a release, download it and read the plugin catalogue. **A visitor never contacts GitHub.**

::: example
**An institute network with no way out.** The viewer, the Explorer, the import and the **data** updates work. Only the administration's *Updates* tab will show "unreachable"; to update, drop the release in by hand (or do it from a connected computer).
:::

## 18.18 What to do if… ?

| Symptom | Probable cause | What to do |
|---|---|---|
| Update refused: "This version cannot be verified" | archive missing from `SHA256SUMS`, or invalid signature | force nothing; tell the publisher |
| Update "automatic restoration done" | the new version did not answer `/api/health` within 30 s | read `logs/update-pivot-*.log` |
| "The server is not answering" after an update | long switch-over or crash | check `logs/`, then reload; the server reconciles by itself at start-up |
| After a PHP update, a page is broken | interrupted copy | **run** the update **again** (idempotent) |
| A plugin disappeared after an update | its `platformCompat` no longer covers the version | *Plugins* tab: update the plugin |
| 429 error on the viewer | the host limits requests per address | check that the `?v=` addresses are being served (cache) |
| Everyone is blocked at login | undeclared proxy (only one address seen) | `--trusted-proxy` (§18.6) |
| PHP administration is slow | session lock | check that the code is up to date (§18.6) |
| Without HTTPS, the import refuses to start | the browser requires a secure context to compute fingerprints | HTTPS, or `localhost` |
| A new dataset does not appear | card hidden, or neither configured nor thumbnailed | edit the card (chapter 14) |

::: remember
- Three servers: **Python** (everything), **PHP** (everything, no automatic rollback), **files** (read-only).
- A **`?v=`** tells the browser "this address never changes": packs 1 year, scripts 7 days; everything else is **revalidated** (304).
- A release is **proven** (pinned Ed25519 signature + SHA-256), **tested** (201 files) and **switched** with a safety net.
- Your **data, passwords and customisations** are never touched by an update.
:::

::: see
- Chapter 10: the brick loader, byte ranges in practice and the `?v=` of packs.
- Chapter 14: the *Import* tab, editing a dataset and the administration screens.
- Chapter 15: plugins, trust, sandbox and the signed catalogue.
- Chapter 19: password, security policy (nonce) and reliability.
- Design details: `DOCS/update-system/` (technical, publication, walkthrough).
:::
