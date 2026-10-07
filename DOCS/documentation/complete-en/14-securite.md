# 14. Security and reliability

::: chapter-intro
- Lumen3D protects the administration panel, the code that runs in the pages and the files that are uploaded. Each protection has a **simple reason**.
- No study data is ever sent to a third party, and the platform works **offline**.
- Reliability rests on **all-or-nothing** publishing and on a suite of about **200 test files** that blocks any faulty release.
:::

## 14.1 The administrator password

There is **no default password**: the first visitor to the panel creates the account (8 characters minimum), and this creation can never overwrite an existing account.

![From password to fingerprint, and the protections against repeated attempts.](img-en/ch14/mot-de-passe.svg){width=100%}

::: analogy
**A fingerprint.** The server keeps the fingerprint of your password, not the password. With a fingerprint you can recognise the right person, but you cannot rebuild the finger.
:::

- The fingerprint is computed with **PBKDF2-HMAC-SHA256**, with a salt unique to the account and 600,000 rounds: deliberately slow, to discourage mass guessing.
- After **10 failures** in 15 minutes from the same address, access is blocked for 15 minutes. Failures are counted **before** the check, and a wrong user name costs the same time as a wrong password.
- A session lasts **8 hours**. Changing the password closes all other sessions.
- Every change also goes through an anti-forgery token (CSRF).

## 14.2 The Content Security Policy (CSP)

::: analogy
**A guest list at the door.** On each page load, the server draws a secret code (the "nonce") and hands it to the site's scripts. The browser lets in only those that present it.
:::

![The nonce, a guest list renewed at every load.](img-en/ch14/csp.svg){width=100%}

The policy is **enforced** (not merely observed). The libraries (Three.js, Lucide, Plotly) are hosted by the site itself: no script comes from elsewhere.

## 14.3 Uploaded files are never served

![The path of an uploaded file up to its publication.](img-en/ch14/import-prive.svg){width=100%}

- Files arrive in `uploads/`, a folder that is **unreachable by URL** (four independent locks).
- An **allowlist** refuses, before anything is written, whatever the pipeline does not produce: no `.php`, no `.js`, no hidden file, no upward path (`..`).
- Only an **explicit publish**, after validation, moves the dataset to `DATA_WEB/`. That folder forbids the execution of scripts.

## 14.4 Plugins: trust and cage

![Trust levels, approval tied to a fingerprint, sandbox.](img-en/ch14/plugins.svg){width=100%}

::: why
A plugin is code. Letting it in unchecked would be like giving a stranger a copy of your keys. By default, an unrecognised plugin **is not loaded**.
:::

- Your approval is tied to the plugin's **exact content** (fingerprint): if it is modified, it loses its trust.
- A plugin also declares which platform versions it is compatible with: when in doubt, it is set aside.

## 14.5 Signed versions and catalogue

::: analogy
**A wax seal.** Only the publisher holds the seal (the private key). Anyone can check that a letter bears it (public key), but nobody can make a fake one.
:::

![The chain of trust of an update: signature, verification, refusal.](img-en/ch14/signatures.svg){width=100%}

- The signature is an **Ed25519** one. The public key is **built into the server's code**: a key supplied with the download could not be trusted.
- A version without a valid signature is **refused**: the updater applies only the archive named after the version and listed in the signed list.
- The plugin catalogue has **its own key** and an increasing serial number, so that nobody can reinstall an older version that has since been fixed.

## 14.6 Your data stays with you

- **No study data** is sent to a third party.
- **Offline**: all the code is hosted on the server. Only the Google Fonts are loaded remotely. GitHub is contacted only by the administrator, to check for updates.
- The statistics are simple counters (visits, views, downloads), rate-limited on the server side.

## 14.7 Reliability

| Risk | Protection |
|---|---|
| An update breaks the site | verified switch-over, automatic rollback, prior backup |
| A publication is interrupted | **all or nothing**: the pipeline builds everything aside and publishes by a rename; an interruption is picked up at the next launch |
| A network outage during an import | resume to the nearest block |
| A corrupt brick | reported and ignored, never sent to the graphics card |
| A regression in the code | about **200 test files** must pass before each release |

::: remember
Each version is **tested in full** before being signed and published. A version that fails the tests simply cannot be released.
:::
