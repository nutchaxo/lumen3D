# 19. Security and reliability

::: chapter-intro
- Lumen3D protects the administration panel, the code that runs in the pages and the files that are uploaded. Each protection has a **simple reason**.
- No study data is ever sent to a third party, and the platform works **offline**.
- Reliability rests on **all-or-nothing** publishing and on a suite of about **200 test files** that blocks any faulty release.
- A single table, "**What happens if…?**" (sections 19.8 to 19.12), lists every foreseen failure and the fallback waiting for it.
:::

## 19.1 The administrator password

There is **no default password**: the first visitor to the panel creates the account (8 characters minimum), and this creation can never overwrite an existing account.

![From password to fingerprint, and the protections against repeated attempts.](img-en/ch19/mot-de-passe.svg){width=100%}

::: analogy
**A fingerprint.** The server keeps the fingerprint of your password, not the password. With a fingerprint you can recognise the right person, but you cannot rebuild the finger.
:::

- The fingerprint is computed with **PBKDF2-HMAC-SHA256**, with a salt unique to the account and 600,000 rounds: deliberately slow, to discourage mass guessing.
- After **10 failures** in 15 minutes from the same address, access is blocked for 15 minutes. Failures are counted **before** the check, and a wrong user name costs the same time as a wrong password.
- A session lasts **8 hours**. Changing the password closes all other sessions.
- Every change also goes through an anti-forgery token (CSRF).

## 19.2 The Content Security Policy (CSP)

::: analogy
**A guest list at the door.** On each page load, the server draws a secret code (the "nonce") and hands it to the site's scripts. The browser lets in only those that present it.
:::

![The nonce, a guest list renewed at every load.](img-en/ch19/csp.svg){width=100%}

The policy is **enforced** (not merely observed). The libraries (Three.js, Lucide, Plotly) are hosted by the site itself: no script comes from elsewhere.

## 19.3 Uploaded files are never served

![The path of an uploaded file up to its publication.](img-en/ch19/import-prive.svg){width=100%}

- Files arrive in `uploads/`, a folder that is **unreachable by URL** (four independent locks).
- An **allowlist** refuses, before anything is written, whatever the pipeline does not produce: no `.php`, no `.js`, no hidden file, no upward path (`..`).
- Only an **explicit publish**, after validation, moves the dataset to `DATA_WEB/`. That folder forbids the execution of scripts.

## 19.4 Plugins: trust and cage

![Trust levels, approval tied to a fingerprint, sandbox.](img-en/ch19/plugins.svg){width=100%}

::: why
A plugin is code. Letting it in unchecked would be like giving a stranger a copy of your keys. By default, an unrecognised plugin **is not loaded**.
:::

- Your approval is tied to the plugin's **exact content** (fingerprint): if it is modified, it loses its trust.
- A plugin also declares which platform versions it is compatible with: when in doubt, it is set aside.

## 19.5 Signed versions and catalogue

::: analogy
**A wax seal.** Only the publisher holds the seal (the private key). Anyone can check that a letter bears it (public key), but nobody can make a fake one.
:::

![The chain of trust of an update: signature, verification, refusal.](img-en/ch19/signatures.svg){width=100%}

- The signature is an **Ed25519** one. The public key is **built into the server's code**: a key supplied with the download could not be trusted.
- A version without a valid signature is **refused**: the updater applies only the archive named after the version and listed in the signed list.
- The plugin catalogue has **its own key** and an increasing serial number, so that nobody can reinstall an older version that has since been fixed.

## 19.6 Your data stays with you

- **No study data** is sent to a third party.
- **Offline**: all the code is hosted on the server. Only the Google Fonts are loaded remotely. GitHub is contacted only by the administrator, to check for updates.
- The statistics are simple counters (visits, views, downloads). What is **kept**: one overall total, one total per day and one total per dataset (with the date of its last view), in `api/stats.json`. Nothing in it is linked to a person.
- The visitor's address is used **in memory only**, to limit the rate: it is reduced to one of 4,096 slots of a "token" table (60 counts in a burst per address, then 1 per second; 600 in a burst for the whole site, then 20 per second). It is written nowhere.

## 19.7 Reliability

| Risk | Protection |
|---|---|
| An update breaks the site (Python server) | switch-over checked by a health probe, **automatic rollback**, prior backup |
| An update fails (PHP hosting) | SHA-256 and signature checks **before** any file is touched; no automatic rollback, but the copy can be **replayed** without damage (chapter 18) |
| A publication is interrupted | **all or nothing**: the pipeline builds everything aside and publishes by a rename; an interruption is picked up at the next launch |
| A network outage during an import | resume to the nearest block |
| A corrupt brick | reported and ignored, never sent to the graphics card |
| A regression in the code | about **200 test files** must pass before each release |

::: remember
Each version is **tested in full** before being signed and published. A version that fails the tests simply cannot be released.
:::

## 19.8 What happens if…? {.page}

::: chapter-intro
- A reliable platform is not one where nothing ever fails: it is one where **every failure has a plan**.
- This part goes through them all: what Lumen3D does, what you see, what you have to do.
- Four families: **the image** (bricks, graphics card), **the data** (import, migration, metadata), **the server** (update, access) and **the browser**.
:::

Three principles guide every fallback. They explain why the answer is almost always "the rest carries on".

:::: cards
::: card
#### Degrade, don't crash
Less detail beats a frozen tab. We drop to the coarser level, set the doubtful brick aside, show a message.
:::
::: card
#### All or nothing
A publication, a conversion or an update is applied **in full** or not at all. Never half a dataset online.
:::
::: card
#### Resume, don't restart
Long operations keep a **journal**: after an interruption, they pick up where they stopped.
:::
::::

::: analogy
**A belt, braces and a waistcoat.** Every risk has its safety net, and often two: the corrupt brick is retried *then* set aside; the server is tested before *and* after the switch-over.
:::

## 19.9 On screen: bricks, workers and metadata

A brick goes through three stages (network, decoding, graphics card). Each has its fallback.

![The three stages of a brick and the fallback of each.](img-en/ch19/replis-brique.svg){width=100%}

| If… | What Lumen3D does | What you see or must do |
|---|---|---|
| A **brick is corrupt** (cannot be decoded, unexpected size) | It is **reported** (`onBrickError`) and **never delivered** to the graphics card; 3 attempts, waiting 0.5 s then 1 s | The rest of the volume is displayed. Nothing to do |
| A **pack stops answering** (nothing arrives for 30 s) | The download is abandoned, then retried (3 attempts) | A progress bar that starts again. Nothing to do |
| A brick is **absent from the index** file | This is not a failure: a completely empty brick is not stored, it is a volume of zeros (chapter 7) | Nothing: it is empty space |
| A **decoding worker crashes** or freezes for more than 30 s | It is replaced (3 times at most) and its task starts again; without a worker, decoding is done in the page | A slight slowdown, never a frozen tab |
| **Another dataset is opened** during a load | The current download batch is cancelled (reason `dataset-switch`), without an error | Nothing: the old dataset simply stops loading |
| The dataset changes brick folder along the way | Tasks planned on the old folder are refused (`BRICKS_MOUNT_CHANGED`) rather than mixed | Nothing: the load is planned again |
| The graphics card offers **no 3D textures** (no WebGL2) | Refused **with a message**; the tab does not crash | Use a recent browser or computer |
| The **metadata file is malformed** | It is **rejected as a whole**, never mounted in part: root that is not an object, invalid x/y/z dimensions, inconsistent channel count, invalid voxel sizes… | A message gives the reason; the administrator fixes the dataset |
| An **optional block** is malformed (stabilisation, cell tracking, gallery…) | That block alone is **dropped with a warning**; the dataset mounts without that feature | The volume is displayed, without the layer concerned |
| The dataset has **more than 4 channels** | The pipeline wrote them all; the viewer draws **four** (RGBA texture) and says so when mounting | The first four channels are visible |
| The **calibration is missing** | No 3D scale bar; a 3D distance measurement is **refused**; in the Studio, measurements are in pixels. No scale is invented (chapters 9 and 12) | The scale does not appear |
| You click **beside the specimen** to measure | The point falls on the bounding box with nothing visible beneath: it is **refused** with a notice | Click on the structure itself |
| A **Compare panel** fails to open | Its error (`PANEL_ERROR`) is shown on that panel alone, with a **Retry** button; saving and the link do not wait for that panel | The other panels carry on |
| A **plugin** is unrecognised, modified or incompatible | It is **not loaded** (quarantined); the other plugins are untouched | The button does not appear (chapters 15 and 19.4) |
| A **`#state=` link** is too big or tampered with | It is not applied (beyond 2 MiB of text, or 16 MiB once decompressed, it is refused); the page opens on its normal view | The link restores nothing; the page works |
| **Browser storage is blocked** (private browsing) | Every read or write is protected: the page works, just without memory | Theme, language and settings are not remembered |

::: tech
The ceilings of **2 MiB** of text and **16 MiB** decompressed, like the **64 KiB** written into the address, protect against a "decompression bomb": a small link that would expand into gigabytes. See appendix B for all the browser's memories.
:::

## 19.10 The graphics card: full memory and lost context

Graphics-card memory is the only real hard ceiling. Lumen3D **plans it before** using it (chapter 10), but a card can still refuse, or reset in the middle of a frame.

![Loss of the graphics context: a single automatic reload, then a safeguard.](img-en/ch19/perte-contexte.svg){width=100%}

| If… | What Lumen3D does | What you see or must do |
|---|---|---|
| The requested level **exceeds the memory budget** | It is not allocated: refusal `SVR_OVER_BUDGET`, move on to the next **coarser** level | A status message says the level could not be allocated and the next one is being tried |
| The card **refuses an allocation** despite the budget | Refusal `SVR_ALLOC_FAILED`; the budget is capped **below the size that failed** for the whole session, then a coarser level | Same message; a lower quality is displayed |
| **No level** fits | The load is declared unavailable (insufficient memory at every level) | Close other tabs, or choose a lower quality |
| The **WebGL context is lost** (driver, sleep, too much memory) | Textures freed, streams stopped; the budget is **halved** (floor 256 MiB), remembered for a week | A status message: graphics context lost, waiting for it to return |
| The context is **restored** | The last view is reloaded with the reduced budget | A status message: context restored, reloading with a lower budget |
| **3 losses within 120 s** | The automatic reload **stops** (otherwise the loop would lock up the GPU) | Choose a lower quality or reload the page |
| A resting frame takes **too long** (over 200 ms) | The ceiling of samples per ray is reduced (chapter 9); a context loss halves it | The image is slightly less fine, the view stays smooth |
| You want to **force a budget** | Operator setting: the browser key `lumen3d.vramBudgetMB` replaces the estimate | Appendix B |

::: why
**Why halve the budget?** A context loss often comes from a driver that cuts off an overlong frame, or from saturated memory. Reloading with the same request would repeat the same mistake: so we ask for **less** next time.
:::

## 19.11 Imports, conversions and metadata

An import of several gigabytes takes hours: an interruption is the rule, not the exception. Everything rests on a **journal** (chapter 17).

![During an import: four failures, four reactions.](img-en/ch19/coupure-import.svg){width=100%}

| If… | What Lumen3D does | What you see or must do |
|---|---|---|
| The **network is cut** during an import | The transfer goes on hold (no failure counted), probes the network (2 s, then up to 15 s) and resumes by itself | The message "Connection lost. The transfer resumes by itself when the network returns.", then the resumption |
| The server answers **5xx, 429** or a wrong checksum | Up to **6 attempts**, waiting 1 s doubled up to 30 s | If everything fails: file in error, **Retry** button |
| The **session expires** during the import | Clean stop, with the message "Session expired — sign in again, then drop the folder once more." | Sign in again and drop the folder again: resumes **to the nearest chunk** |
| The **disk is full** | Before writing, the need is compared with the free space; on the way, error 507 with "needed / free" | Free some space, then resume |
| You **close the tab** mid-import | The server journal keeps the chunks received (binary map of chunks) | Drop the folder again: only the missing chunks start again |
| A chunk is **sent twice**, or out of order | Written at its exact position; sent again, it has no effect | Nothing |
| A file is **forbidden** (`.php`, `.js`, hidden file, path with `..`) | Refused **before** anything is written, by the allowlist | The file is listed as refused |
| A **folder of unknown type** is dropped, or the announced type does not match the folder | Refused (`metadata_type_mismatch`, `metadata_bad_type`); the editor says "invalid type" | Only `3d`, `2d` and `live` exist (chapter 17) |
| A **pack is truncated** or missing | The publication is **refused**: the brick index must point inside packs that are long enough (`incomplete_files`) | Finish the transfer, then publish |
| An **unexpected file** lingers in the waiting area | Publication refused (`stray_files`) rather than carrying it into the site | Delete it or redo the import |
| `metadata.json` is **missing, unreadable or invalid** | Publication refused with the list of errors (`missing_metadata`, `metadata_no_dimensions`, `metadata_bad_dimensions`…) | Fix it in the dataset editor |
| A **manifest** announces a brick other than 64 or levels out of order | Refused at import, by both servers | Run the pipeline again |
| The source dataset **changes during a conversion** | The job is invalidated (`source_changed`) rather than mixing two versions | Start the conversion again |
| A conversion is **interrupted** (tab closed, server restarted) | The journal and the tile store are shared by the browser and the server: it resumes at the same point, even with the other executor | Reopen the [Data updates]{.ui} tab |
| The **finalisation** of a conversion is interrupted | It can be resumed (`complete:false` until it is done), then replaces the old content in a single move | Run it again: it finishes |
| A **unit kills the request twice** (time-limited host) | Answer `unit_timeout`: that conversion switches to the browser; the other units keep their progress | Nothing: the work carries on |
| The **host stops answering** or refuses (429, 503) | The request governor halves its pace and pauses (5 s, doubled up to 60 s) | A slower conversion, never a flood |
| The server **cannot decode WebP** or the browser cannot encode it losslessly | A capability probe detects it; the other executor is offered | A message in the tab |
| The **pipeline is interrupted** in the middle of a publication | The `.swap-in-progress` marker lets the next launch **finish or undo** the swap | Run the pipeline again |
| A dataset is **republished** over an existing one | The laboratory's settings (hidden, orientation, gallery, corrected stage…) are **kept** | Nothing to redo |

::: example
**A 20-minute outage.** You are importing an 8 GB embryo. At 60 %, the Wi-Fi drops. The transfer goes "offline", probes every 2 to 15 s, then resumes by itself when the network returns: **no file is lost** and no attempt is counted. Had you shut the computer, it would be enough to drop the folder again.
:::

## 19.12 Server: updates, access and hosting limits

| If… | What Lumen3D does | What you see or must do |
|---|---|---|
| The **new version does not start** (Python server) | Dry-run check before the switch-over; after it, `/api/health` probe (about 30 s); on failure: **automatic rollback** to the old version | A "cancelled" state in the Updates tab |
| The **server stops** during the switch-over | A journal remains; at the next start, it is either completed (target version reached) or **entirely undone** | Restart the server |
| The update fails on **PHP hosting** | **No automatic rollback**: the copy can be replayed without damage, a busy file is set aside (`.lumen-new`) then finished at the next request | Run the update again |
| Two administrators **start the update together** | The second request is refused (`update_in_progress`) | Wait for the first to finish |
| The **download is truncated** | The announced size is checked, and the SHA-256 sum too: error and abandon | Run it again |
| **Space is short** for the update | The prior check (same volume, disk space, backup folder) refuses before touching anything | Free some space |
| The version **is not signed**, or the signature is wrong | It is **refused**; only the archive named after the version and listed in the signed list is applied | A refusal (`unverifiable_release`) whose reason is shown in the Updates tab |
| The **plugin catalogue is older** than the last one seen | Refused (decreasing serial number: `catalog_rollback`) | No plugin is installed from that catalogue |
| A **plugin becomes incompatible** after an update | It is set aside and re-enabled when a compatible version exists | See the Plugins tab |
| You type **ten wrong passwords** | 15-minute block for that address; failures are counted before the check | Wait, or use the right password |
| Your **administration session expires** (8 h) | The form's unsaved changes are **kept** on screen | Sign in again, then save |
| A visit counter is **flooded** with requests | Two token buckets (per address and global) ignore the excess; a GET does not count | Nothing |
| The host **limits PHP's time or memory** | Each conversion step sets its own time limit; big units are cut into 8 octants; request bodies are capped (32 MiB per unit) | A slower conversion, never a corrupt one |
| **No Internet** | Everything works: the libraries are local; only the fonts (falling back to system ones) and the administrator's GitHub checks need it | Updates and catalogue unavailable |

::: warning
Fallbacks **protect**, they do not **repair** everything. A pack erased from the disk, a metadata file edited by hand, or hosting with no free space call for human action: the platform refuses cleanly and tells you why, that is all.
:::

## 19.13 What to remember

::: remember
- **Image**: a doubtful brick is set aside, never displayed wrongly; the graphics card is spared before it is called upon.
- **Data**: we publish in full or not at all; long operations **resume**.
- **Server**: Python returns by itself to the old version; PHP can be rerun safely, but by hand.
- **No interruption** (network, tab, session) loses an import already begun.
:::
