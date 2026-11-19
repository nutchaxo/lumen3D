"""Page version history — the Python store (dev_server.py `_pv_*`) and its PHP twin
(api/page-versions.php + api/_page_versions_lib.php) are twins.

The SAME scripted sequence of operations (SPEC pages-library §3: add with and without
activation, update label / note / content / fromLive, activate publish and draft, delete
refusal, purge, the 50-version ceiling, a deleted page restored, and a long list of garbage
inputs) is driven four times, each on a throwaway tree:

    py        every step through the Python store, in this process
    php       every step through the PHP store, in `php` CLI library mode (LUMEN_PV_LIB)
    py/php    steps alternate Python, PHP, Python …  on ONE tree
    php/py    steps alternate PHP, Python, PHP …     on ONE tree

The two alternating runs are the cross-read proof: a history written by one backend is read
and extended by the other, and a live page written by one is read by the other.

After every step the transcript holds the answer (status + payload) and the whole state of
the three directories a request can touch — config/pages (live pages), api/page-drafts,
api/page-versions — and the four transcripts must be identical once ONLY the version ids
(replaced by aliases), the server timestamps and the `rev` hashes are masked.

State is compared as parsed JSON, key order included, empty `{}` vs `[]` included — not as
text: PHP's encoder (`JSON_PRETTY_PRINT`, 4 spaces) and Python's (`indent=2`) differ in
white-space and in `\\/` escaping, which no reader can observe (the live pages are written the
same way by the two backends, long before this feature). The stored values never carry a
JSON number with a zero fraction (`1.0`): the browser never writes one, and PHP's encoder
would turn it into `1`.

What is NOT compared, on purpose: the wording of `detail` (a log hint: only its presence is),
the key order of a live page file (the editor's document), and the HTTP entry layer itself (sockets, CSRF,
sessions: test_entry_layer_agrees_on_a_malformed_body covers the body rule). A numeric-string
column width ("7") is also left out: the page-doc gates of the two backends (`_validate_page_doc`
and `site_validate_page`, older than this feature) clamp it differently.

    python tests/test_page_versions_parity.py
"""
import contextlib
import hashlib
import io
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import dev_server as ds  # noqa: E402


def _find_php():
    for cand in ("php", r"C:\php-portable\php.exe"):
        found = shutil.which(cand) or (cand if os.path.isfile(cand) else None)
        if found:
            return found
    return None


PHP = _find_php()
if not PHP:
    print("SKIP: php not available - the PHP twin of the page version store was not compared")

SLUG_ABOUT = "about"

# ── the PHP side: a driver that answers one JSON command per line ──────────────

PHP_DRIVER = r"""<?php
declare(strict_types=1);
$root = $argv[1];
$api = $argv[2];
define('LUMEN_PRIVATE_DIR', $root);
define('LUMEN_CRED_FILE', $root . '/admin_credential.json');
define('LUMEN_CONFIG_DIR', $root . '/config');
define('LUMEN_PAGE_DRAFTS_DIR', $root . '/api/page-drafts');
define('LUMEN_PAGE_VERSIONS_DIR', $root . '/api/page-versions');
define('LUMEN_SITE_LIB', true);
define('LUMEN_PV_LIB', true);
@ini_set('memory_limit', '1024M');
require_once $api . '/page-versions.php';

$noise = [];
set_error_handler(function ($no, $str, $file, $line) use (&$noise) {
    if (!(error_reporting() & $no)) return true;
    $noise[] = "$str @ " . basename($file) . ":$line";
    return true;
});

$flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION | JSON_PARTIAL_OUTPUT_ON_ERROR;
while (($line = fgets(STDIN)) !== false) {
    $cmd = json_decode($line, true);
    if (!is_array($cmd)) { echo json_encode(['fatal' => 'bad command']) . "\n"; continue; }
    $noise = [];
    $action = (string)$cmd['action'];
    $p = $cmd['params'];
    // The entry point (api/page-versions.php) reads the query through lumen_str and the body through
    // lumen_json_decode_doc; a write has the body-size ceiling and "not JSON" refusal of its own.
    $slug = lumen_str($p['slug'] ?? null);
    $id = lumen_str($p['id'] ?? null);
    $raw = $cmd['body'];
    $body = null;
    $early = null;
    if (in_array($action, ['add', 'update', 'activate', 'delete', 'purge'], true) && is_string($raw)) {
        if (strlen($raw) > PV_MAX_BODY) $early = [413, ['error' => 'version_too_large']];
        elseif (trim($raw) !== '') {
            $body = lumen_json_decode_doc($raw);
            if ($body === null && trim($raw) !== 'null') $early = [400, ['error' => 'invalid_body']];
        }
    }
    [$st, $out] = $early ?? pv_handle($action, $slug, $id, $body);
    echo json_encode(['status' => $st, 'payload' => $out, 'noise' => $noise], $flags) . "\n";
    fflush(STDOUT);
}
"""


class PhpBackend:
    name = "php"

    def __init__(self, tree, workdir):
        self.driver = Path(workdir) / "pv_driver.php"
        self.driver.write_text(PHP_DRIVER, encoding="utf-8")
        self.proc = subprocess.Popen(
            [PHP, "-d", "display_errors=stderr", str(self.driver), str(tree), str(ROOT / "api")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.noise = []

    def call(self, action, params, raw_body):
        cmd = {"action": action, "params": params, "body": raw_body}
        self.proc.stdin.write((json.dumps(cmd) + "\n").encode("utf-8"))
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            err = self.proc.stderr.read().decode("utf-8", "replace")
            raise AssertionError(f"the PHP driver died on {action} {params}:\n{err}")
        res = json.loads(line.decode("utf-8"))
        if "fatal" in res:
            raise AssertionError(res["fatal"])
        if res["noise"]:
            self.noise.append((action, params, res["noise"]))
        return res["status"], res["payload"]

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            err = self.proc.stderr.read().decode("utf-8", "replace")
        except OSError:
            err = ""
        self.proc.wait(timeout=30)
        self.proc.stdout.close()
        self.proc.stderr.close()
        if err.strip():
            self.noise.append(("stderr", None, [err.strip()]))


class PyBackend:
    """The Python store, called the way dev_server.py's route calls it: params from the query
    string (a blank value is dropped by parse_qsl), the body decoded by do_POST's own function."""
    name = "py"

    def call(self, action, params, raw_body):
        q = {k: v for k, v in params.items() if v is not None and v != ""}
        body = ds._pv_decode_body(raw_body) if raw_body is not None else None   # do_POST's own decoding
        with contextlib.redirect_stderr(io.StringIO()):     # the store logs what it parks or refuses
            return ds._pv_handle(action, q, body)

    def close(self):
        pass


_PATCHED = ("ROOT", "DATA_WEB", "CONFIG_DIR", "CONFIG_DEFAULTS_DIR", "INSTANCE_FILE", "THEME_CSS_FILE",
            "PAGE_DRAFTS_DIR", "PAGE_VERSIONS_DIR")


@contextlib.contextmanager
def python_tree(root: Path):
    saved = {k: getattr(ds, k) for k in _PATCHED}
    ds.ROOT = root
    ds.DATA_WEB = root / "DATA_WEB"
    ds.CONFIG_DIR = root / "config"
    ds.CONFIG_DEFAULTS_DIR = root / "config" / "defaults" / "neutral"
    ds.INSTANCE_FILE = root / "config" / "instance.json"
    ds.THEME_CSS_FILE = root / "config" / "theme.css"
    ds.PAGE_DRAFTS_DIR = root / "api" / "page-drafts"
    ds.PAGE_VERSIONS_DIR = root / "api" / "page-versions"
    ds.CONFIG_DEFAULTS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        yield
    finally:
        for k, v in saved.items():
            setattr(ds, k, v)


# ── content builders (every value JSON-exact on both sides: no `1.0`) ───────────

def widget(text, **props):
    return {"id": "w-" + text.lower().replace(" ", "-")[:20], "type": "heading",
            "props": {"text": {"en": text, "fr": text + " fr"}, **props}}


def block(tag, text="Hello", extra=()):
    return {"sections": [{"id": "s-" + tag, "props": {}, "columns": [
        {"id": "c-" + tag, "width": 12, "props": {}, "widgets": [widget(text), *extra]}]}]}


TRICKY_WIDGET = {
    "id": "w-tricky", "type": "richtext",
    "props": {
        "html": "<b>caf\u00e9 \u2014 \U0001F600 / \\ \"q\" \t tab \u2028 & 'a'</b>",
        "ratio": 0.5, "big": 12345678901, "neg": -3, "off": False, "on": True, "none": None,
        "emptyObj": {}, "emptyList": [], "url": "https://example.org/a/b?c=1&d=2",
        "order": {"zz": 1, "aa": 2, "mm": {"y": [1, 2, {"k": "v"}], "x": {}}},
        "numKeys": {"1": "a", "2": "b"}, "zeroKeys": {"0": "a", "1": "b"},
        "text": {"en": "Tricky", "fr": "D\u00e9licat", "de": "Heikel"},
    },
}


def tricky_block(tag="t"):
    return block(tag, "Tricky " + tag, (TRICKY_WIDGET,))


def legacy_blocks():
    return {"blocks": [{"type": "heading", "props": {"text": {"en": "Legacy"}}},
                       {"type": "text", "props": {"body": "x"}}]}


def content(published=None, draft=None, title=None, nav=None, **extra):
    c = {}
    if title is not None:
        c["title"] = title
    if nav is not None:
        c["nav"] = nav
    if published is not None:
        c["published"] = published
    if draft is not None:
        c["draft"] = draft
    c.update(extra)
    return c


TITLE = {"en": "About", "fr": "\u00c0 propos"}
NAV = {"label": {"en": "About", "fr": "\u00c0 propos"}, "show": True}


# ── the script ──────────────────────────────────────────────────────────────────
# A step is one of
#   ("fs",   name, fn(root))                       arrange the live files (same bytes for every run)
#   ("call", name, action, params, body, save)     one request; body = python value (JSON-encoded) or
#                                                   a str sent as raw text; "@x" in params = saved id;
#                                                   save = {response field: alias}

def write_live(root: Path, slug, published=None, draft=None, title=None, inline_draft=None):
    pages = root / "config" / "pages"
    drafts = root / "api" / "page-drafts"
    pages.mkdir(parents=True, exist_ok=True)
    doc = {}
    if title is not None:
        doc["title"] = title
    if published is not None:
        doc["published"] = published
    doc["schemaVersion"] = 2
    if inline_draft is not None:
        doc["draft"] = inline_draft
    (pages / f"{slug}.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
    if draft is not None:
        drafts.mkdir(parents=True, exist_ok=True)
        (drafts / f"{slug}.json").write_text(json.dumps(draft, indent=2, ensure_ascii=False), encoding="utf-8")
    elif (drafts / f"{slug}.json").exists():
        (drafts / f"{slug}.json").unlink()


def remove_live(root: Path, slug):
    for p in (root / "config" / "pages" / f"{slug}.json", root / "api" / "page-drafts" / f"{slug}.json"):
        if p.exists():
            p.unlink()


def S(name, action, slug=None, vid=None, body=None, save=None, **params):
    p = {}
    if slug is not None:
        p["slug"] = slug
    if vid is not None:
        p["id"] = vid
    p.update(params)
    return ("call", name, action, p, body, save or {})


def FS(name, fn):
    return ("fs", name, fn)


def main_steps():
    A = content(published=block("a", "Alpha"), draft=block("a2", "Alpha draft"), title=TITLE, nav=NAV)
    B = content(published=tricky_block("b"), nav={"label": {"en": "B"}, "show": False})
    C = content(draft=block("c", "Gamma"))
    steps = [
        S("list: nothing yet", "list"),
        S("list one slug: nothing yet", "list", SLUG_ABOUT),
        FS("live about = P0 + private draft D0", lambda r: write_live(
            r, SLUG_ABOUT, block("p0", "Live"), block("d0", "Live draft"), {"en": "Live about"})),
        S("add A + activate publish (live state not captured yet: safety snapshot)", "add", SLUG_ABOUT, body={
            "origin": "capture", "label": "  Spring redesign  ", "note": "first", "content": A,
            "exportedAt": "2026-11-18T09:00:00.000Z", "source": "bemine.be", "platform": "1.86.0",
            "activate": "publish", "snapshotLabel": "Safety"}, save={"id": "A", "snapshotId": "S1"}),
        S("add B (import, tricky content, no activation)", "add", SLUG_ABOUT, body={
            "origin": "import", "label": "Imported", "note": "line1\nline2\ttab\x01ctrl", "content": B,
            "exportedAt": "x" * 100, "source": "a\x00b\nc", "platform": "1.87.0"}, save={"id": "B"}),
        S("add C (draft only)", "add", SLUG_ABOUT, body={"origin": "manual", "content": C}, save={"id": "C"}),
        S("add legacy blocks form", "add", SLUG_ABOUT, body={
            "origin": "auto", "label": "Legacy", "content": content(published=legacy_blocks())}, save={"id": "L"}),
        S("list about", "list", SLUG_ABOUT),
        S("list all", "list"),
        S("get A", "get", SLUG_ABOUT, "@A"),
        S("get B", "get", SLUG_ABOUT, "@B"),
        S("get C", "get", SLUG_ABOUT, "@C"),
        S("get missing id", "get", SLUG_ABOUT, "v0123456789ab"),
        S("update B label", "update", SLUG_ABOUT, "@B", {"label": "Renamed \u2713"}),
        S("update B note", "update", SLUG_ABOUT, "@B", {"note": "multi\nline\tnote"}),
        S("update B label blank = Version", "update", SLUG_ABOUT, "@B", {"label": "   "}),
        S("update B label too long", "update", SLUG_ABOUT, "@B", {"label": "L" * 130}),
        S("update B content", "update", SLUG_ABOUT, "@B", {"content": content(
            published=block("b2", "Beta"), draft=block("b3", "Beta draft"), title={"en": "B"})}),
        S("update C fromLive", "update", SLUG_ABOUT, "@C", {"fromLive": True}),
        S("activate B publish", "activate", SLUG_ABOUT, "@B", {}),
        S("activate B publish again (no change)", "activate", SLUG_ABOUT, "@B", {"mode": "publish"}),
        FS("editor edits the live page (P1 + D1)", lambda r: write_live(
            r, SLUG_ABOUT, block("p1", "Edited"), block("d1", "Edited draft"), {"en": "Edited"})),
        S("activate A publish (live modified: safety snapshot, default label)", "activate", SLUG_ABOUT, "@A",
          None, save={"snapshotId": "S2"}),
        S("activate A publish again", "activate", SLUG_ABOUT, "@A", {}),
        S("activate C as draft", "activate", SLUG_ABOUT, "@C", {"mode": "draft", "snapshotLabel": "Draft swap"}),
        S("activate C as draft again", "activate", SLUG_ABOUT, "@C", {"mode": "draft"}),
        S("activate L as draft", "activate", SLUG_ABOUT, "@L", {"mode": "draft"}),
        S("activate L publish (legacy blocks)", "activate", SLUG_ABOUT, "@L", {"mode": "publish"}),
        S("delete the active version", "delete", SLUG_ABOUT, "@L"),
        S("delete C", "delete", SLUG_ABOUT, "@C"),
        S("delete C again", "delete", SLUG_ABOUT, "@C"),
        S("delete missing id", "delete", SLUG_ABOUT, "v0123456789ab"),
        S("update a deleted version", "update", SLUG_ABOUT, "@C", {"label": "ghost"}),
        S("activate a deleted version", "activate", SLUG_ABOUT, "@C", {}),
        S("get a deleted version", "get", SLUG_ABOUT, "@C"),
        S("add E equal to the live state + activate (no snapshot expected)", "add", SLUG_ABOUT, body={
            "origin": "capture", "content": content(published=block("a", "Alpha"), draft=block("a2", "Alpha draft")),
            "activate": "publish"}, save={"id": "E"}),
        FS("the page is deleted (live files gone)", lambda r: remove_live(r, SLUG_ABOUT)),
        S("update A fromLive on a deleted page", "update", SLUG_ABOUT, "@A", {"fromLive": True}),
        S("activate A restores the deleted page", "activate", SLUG_ABOUT, "@A", {}),
        S("update E fromLive", "update", SLUG_ABOUT, "@E", {"fromLive": True, "label": "From live", "note": "n"}),
        FS("live about with a LEGACY inline draft", lambda r: write_live(
            r, SLUG_ABOUT, block("p9", "Legacy live"), None, {"en": "Legacy"}, inline_draft=block("d9", "Inline"))),
        S("activate E publish over a legacy inline draft", "activate", SLUG_ABOUT, "@E", {}),
        S("add with activation on a page that has no live file: draft", "add", "home", body={
            "origin": "import", "label": "Home v1", "content": content(published=block("h1", "Home"), title={"en": "Home"}),
            "activate": "draft"}, save={"id": "H1"}),
        S("add home v2 + activate publish", "add", "home", body={
            "origin": "capture", "label": "Home v2", "content": content(draft=block("h2", "Home 2")),
            "activate": "publish"}, save={"id": "H2", "snapshotId": "HS"}),
        S("list all (about + home)", "list"),
        S("delete home H1", "delete", "home", "@H1"),
        S("delete the last non-active, then the active is refused", "delete", "home", "@H2"),
        S("purge home", "purge", "home"),
        S("purge home again (idempotent)", "purge", "home"),
        S("list home after purge", "list", "home"),
        S("get home after purge", "get", "home", "@H2"),
        S("activate home after purge", "activate", "home", "@H2", {}),
    ]
    return steps


def bulk_steps():
    steps = [FS("bulk: live page", lambda r: write_live(r, "bulk", block("bp", "Bulk live"), block("bd", "Bulk draft")))]
    for i in range(50):
        steps.append(S(f"bulk add #{i + 1}", "add", "bulk", body={
            "origin": "manual", "label": f"v{i + 1}", "content": content(published=block(f"k{i}", f"Bulk {i}"))},
            save={"id": f"K{i}"}))
    steps += [
        S("bulk add #51 refused", "add", "bulk", body={"origin": "manual", "content": content(published=block("z"))}),
        S("bulk add #51 with activation refused", "add", "bulk", body={
            "origin": "manual", "content": content(published=block("z")), "activate": "publish"}),
        S("bulk activate needs a safety snapshot while full", "activate", "bulk", "@K0", {}),
        S("bulk list", "list", "bulk"),
        S("bulk delete K1", "delete", "bulk", "@K1"),
        S("bulk add + activation at 49 over an unsaved live state: refused, nothing stored", "add", "bulk", body={
            "origin": "manual", "content": content(published=block("z")), "activate": "publish"}),
        S("bulk list after the refused add + activation", "list", "bulk"),
        S("bulk activate K0 (one slot free: snapshot taken)", "activate", "bulk", "@K0", {}, save={"snapshotId": "BS"}),
        S("bulk add refused again (full)", "add", "bulk", body={"origin": "manual", "content": content(published=block("z"))}),
        S("bulk purge", "purge", "bulk"),
    ]
    return steps


def garbage_steps():
    g = "garb"
    ok = content(published=block("g", "Good"))
    steps = [S("garb: seed", "add", g, body={"origin": "capture", "content": ok}, save={"id": "G"})]
    bad_slugs = ["../evil", "..", ".", "a/b", "a\\b", "a\x00b", "A", "About", "-x", "_x", "x.json", "a b",
                 "x" * 65, "%2e%2e", "x\n", "h\u00e9"]
    for s in bad_slugs:
        for action in ("list", "get", "add", "update", "activate", "delete", "purge"):
            steps.append(S(f"slug {s!r} {action}", action, s, "@G", {"origin": "capture", "content": ok}))
    steps.append(S("slug 64 chars ok list", "list", "a" * 64))
    steps.append(S("slug blank list = no filter", "list", ""))
    steps.append(S("slug missing get", "get", None, "@G"))
    steps.append(S("slug missing add", "add", None, body={"origin": "capture", "content": ok}))
    steps.append(S("slug missing purge", "purge"))
    bad_ids = ["", "V0123456789AB", "v0123456789a", "v0123456789abc", "../x", "v0123456789ab\n", "v0123456789ag",
               " v0123456789ab"]
    for i in bad_ids:
        for action in ("get", "update", "activate", "delete"):
            steps.append(S(f"id {i!r} {action}", action, g, i, {"label": "x"}))
    for action in ("get", "update", "activate", "delete"):
        steps.append(S(f"id missing {action}", action, g, None, {"label": "x"}))
    for a in ("frobnicate", "", "LIST", "List", "list ", "../list"):
        steps.append(S(f"unknown action {a!r}", a, g))

    bodies = {
        "no body": None, "empty list": "[]", "list": "[1,2]", "string": '"str"', "number": "123", "null": "null",
        "not json": "{bad", "blank": "   ", "empty object": "{}", "true": "true",
    }
    for n, b in bodies.items():
        steps.append(S(f"add body {n}", "add", g, body=b))
        steps.append(S(f"update body {n}", "update", g, "@G", b))
        steps.append(S(f"activate body {n}", "activate", g, "@G", b))
        steps.append(S(f"delete body {n}", "delete", g, "v0123456789ab", b))
        steps.append(S(f"purge body {n}", "purge", "nothere", b))
    for o in (None, "bogus", 5, ["import"], "", "IMPORT", True, {}):
        steps.append(S(f"origin {o!r}", "add", g, body={"origin": o, "content": ok}))
    steps.append(S("origin missing", "add", g, body={"content": ok}))
    for m in ("bogus", 5, "Publish", "", True, ["draft"], {}):
        steps.append(S(f"add activate {m!r}", "add", g, body={"origin": "capture", "content": ok, "activate": m}))
        steps.append(S(f"activate mode {m!r}", "activate", g, "@G", {"mode": m}))
    steps.append(S("activate mode null", "activate", g, "@G", {"mode": None}))

    contents = {
        "missing": "MISSING", "null": None, "string": "x", "list": [], "number": 1, "empty": {},
        "title only": {"title": {"en": "T"}}, "both null": {"published": None, "draft": None},
        "published list": {"published": []}, "published empty": {"published": {}},
        "published string": {"published": "x"}, "sections string": {"published": {"sections": "x"}},
        "sections null": {"published": {"sections": None}},
        "sections item int": {"published": {"sections": [1]}},
        "columns string": {"published": {"sections": [{"columns": "x"}]}},
        "column int": {"published": {"sections": [{"columns": [1]}]}},
        "widgets string": {"published": {"sections": [{"columns": [{"widgets": "x"}]}]}},
        "widget empty": {"published": {"sections": [{"columns": [{"widgets": [{}]}]}]}},
        "widget type int": {"published": {"sections": [{"columns": [{"widgets": [{"type": 5}]}]}]}},
        "sections 301": {"published": {"sections": [{} for _ in range(301)]}},
        "sections 300": {"published": {"sections": [{} for _ in range(300)]}},
        "columns 13": {"published": {"sections": [{"columns": [{} for _ in range(13)]}]}},
        "columns 12": {"published": {"sections": [{"columns": [{} for _ in range(12)]}]}},
        "widgets 501": {"published": {"sections": [{"columns": [{"widgets": [{"type": "t"} for _ in range(501)]}]}]}},
        "widgets 500": {"published": {"sections": [{"columns": [{"widgets": [{"type": "t"} for _ in range(500)]}]}]}},
        "blocks ok": {"published": {"blocks": [{"type": "heading"}]}},
        "blocks int": {"published": {"blocks": [1]}},
        "blocks no type": {"published": {"blocks": [{}]}},
        "blocks 501": {"published": {"blocks": [{"type": "t"} for _ in range(501)]}},
        "blocks empty": {"published": {"blocks": []}},
        "sections empty": {"published": {"sections": []}},
        "sections + blocks": {"published": {"sections": [], "blocks": 5}},
        "draft only bad": {"draft": {"sections": "x"}},
        "published ok draft bad": {"published": block("ok"), "draft": []},
        "width 99": {"published": {"sections": [{"columns": [{"width": 99, "widgets": []}]}]}},
        "width 0": {"published": {"sections": [{"columns": [{"width": 0, "widgets": []}]}]}},
        "width 3.7": {"published": {"sections": [{"columns": [{"width": 3.7, "widgets": []}]}]}},
        "width -4": {"published": {"sections": [{"columns": [{"width": -4, "widgets": []}]}]}},
        "background kept": {"published": {"sections": [], "background": {"color": "#fff"}}},
        "unknown keys dropped": {"published": block("u"), "junk": 1, "schemaVersion": 9},
        "title string": {"title": "Plain", "published": block("t1")},
        "title list": {"title": [], "published": block("t2")},
        "title empty obj": {"title": {}, "published": block("t3")},
        "title null": {"title": None, "published": block("t4")},
        "title value int": {"title": {"en": 1}, "published": block("t5")},
        "title key 17": {"title": {"k" * 17: "a"}, "published": block("t6")},
        "title key 16": {"title": {"k" * 16: "a"}, "published": block("t7")},
        "title key empty": {"title": {"": "a"}, "published": block("t8")},
        "title key space": {"title": {"a b": "a"}, "published": block("t9")},
        "title 4000 chars": {"title": {"en": "x" * 4000}, "published": block("t10")},
        "title 4001 chars": {"title": {"en": "x" * 4001}, "published": block("t11")},
        "title 4000 two-byte chars": {"title": {"en": "\u00e9" * 4000}, "published": block("t12")},
        "title 4001 two-byte chars": {"title": {"en": "\u00e9" * 4001}, "published": block("t12b")},
        "title 4000 astral chars": {"title": {"en": "\U0001F600" * 4000}, "published": block("t12c")},
        "title 64 keys": {"title": {f"k{i:02d}": "a" for i in range(64)}, "published": block("t13")},
        "title 65 keys": {"title": {f"k{i:02d}": "a" for i in range(65)}, "published": block("t14")},
        "nav label 65 keys": {"nav": {"label": {f"k{i:02d}": "a" for i in range(65)}}, "published": block("t15")},
        "nav string": {"nav": "x", "published": block("n1")},
        "nav list": {"nav": [], "published": block("n2")},
        "nav empty": {"nav": {}, "published": block("n3")},
        "nav show string": {"nav": {"show": "yes"}, "published": block("n4")},
        "nav show int": {"nav": {"show": 1}, "published": block("n5")},
        "nav label int": {"nav": {"label": 5}, "published": block("n6")},
        "nav label string": {"nav": {"label": "Plain"}, "published": block("n7")},
        "nav label empty": {"nav": {"label": {}}, "published": block("n8")},
        "nav only show": {"nav": {"show": False}, "published": block("n9")},
        "nav unknown key": {"nav": {"show": True, "junk": 1}, "published": block("n10")},
        "nav null": {"nav": None, "published": block("n11")},
    }
    for n, c in contents.items():
        body = {"origin": "manual", "label": f"c:{n}"}
        if c != "MISSING":
            body["content"] = c
        steps.append(S(f"content {n}", "add", g, body=body, save={"id": f"X-{n}"}))
        if len([1 for s in steps if s[1].startswith("content ")]) % 40 == 0:
            steps.append(S("garb: tidy (purge)", "purge", g))
            steps.append(S("garb: reseed", "add", g, body={"origin": "capture", "content": ok}, save={"id": "G"}))
    steps.append(S("garb: tidy (purge) 2", "purge", g))
    steps.append(S("garb: reseed 2", "add", g, body={"origin": "capture", "content": ok}, save={"id": "G"}))

    for n, v in {"int": 5, "list": [1], "object": {}, "bool": True, "empty": "", "blank": "   ",
                 "controls": "a\x00b\x1fc\x7fd\te\nf", "2000 + 1": "n" * 2001,
                 "nbsp edges": " x ", "inner breaks": " a\tb\r\nc \n", "em space": "a b ",
                 "next line": "a\u0085b", "line separator": "a b"}.items():
        steps.append(S(f"label {n}", "add", g, body={"origin": "capture", "content": ok, "label": v}))
        steps.append(S(f"note {n}", "add", g, body={"origin": "capture", "content": ok, "note": v}))
        steps.append(S(f"snapshotLabel {n}", "add", g, body={
            "origin": "capture", "content": ok, "snapshotLabel": v}))
        steps.append(S(f"exportedAt {n}", "add", g, body={"origin": "capture", "content": ok, "exportedAt": v}))
        steps.append(S(f"source {n}", "add", g, body={"origin": "capture", "content": ok, "source": v}))
        steps.append(S(f"platform {n}", "add", g, body={"origin": "capture", "content": ok, "platform": v}))
        steps.append(S(f"update label {n}", "update", g, "@G", {"label": v}))
        steps.append(S(f"update note {n}", "update", g, "@G", {"note": v}))
        steps.append(S(f"activate snapshotLabel {n}", "activate", g, "@G", {"snapshotLabel": v}))
    steps.append(S("label 120 + trailing space cut", "add", g, body={
        "origin": "capture", "content": ok, "label": "a" * 119 + " b"}))
    steps.append(S("label 121 multibyte", "add", g, body={"origin": "capture", "content": ok, "label": "\u00e9" * 121}))
    steps.append(S("label astral", "add", g, body={"origin": "capture", "content": ok, "label": "\U0001F600" * 121}))
    steps.append(S("note 2000 multibyte", "add", g, body={"origin": "capture", "content": ok, "note": "\u00e9" * 2001}))

    steps += [
        S("update nothing", "update", g, "@G", {}),
        S("update only unknown key", "update", g, "@G", {"junk": 1}),
        S("update fromLive false", "update", g, "@G", {"fromLive": False}),
        S("update fromLive false + label", "update", g, "@G", {"fromLive": False, "label": "l"}),
        S("update fromLive null + label", "update", g, "@G", {"fromLive": None, "label": "l"}),
        S("update fromLive string", "update", g, "@G", {"fromLive": "yes"}),
        S("update fromLive 1", "update", g, "@G", {"fromLive": 1}),
        S("update fromLive + content", "update", g, "@G", {"fromLive": True, "content": ok}),
        S("update content null only", "update", g, "@G", {"content": None}),
        S("update content bad", "update", g, "@G", {"content": {"title": {"en": "x"}}}),
        S("update content string", "update", g, "@G", {"content": "x"}),
        S("update content good + label null", "update", g, "@G", {"content": ok, "label": None}),
        S("update label + note + content", "update", g, "@G", {"label": "l", "note": "n", "content": ok}),
        S("update fromLive: no live page", "update", g, "@G", {"fromLive": True}),
        FS("garb: live page with a draft only in the private file", lambda r: (
            write_live(r, g, {"sections": []}, block("gd", "Garb draft")))),
        S("update fromLive: live page present", "update", g, "@G", {"fromLive": True}),
        FS("garb: live page whose published block is not a block", lambda r: (
            (r / "config" / "pages").mkdir(parents=True, exist_ok=True),
            (r / "config" / "pages" / f"{g}.json").write_text('{"published": "oops", "schemaVersion": 2}', encoding="utf-8"),
            (r / "api" / "page-drafts" / f"{g}.json").unlink() if (r / "api" / "page-drafts" / f"{g}.json").exists() else None)),
        S("activate over a live page with no usable block", "activate", g, "@G", {}),
        S("update fromLive: live page with no usable block", "update", g, "@G", {"fromLive": True}),
        FS("garb: live page is a JSON list", lambda r: (r / "config" / "pages" / f"{g}.json").write_text("[1]", encoding="utf-8")),
        S("activate over a live page that is a list", "activate", g, "@G", {}),
        FS("garb: live page is not JSON", lambda r: (r / "config" / "pages" / f"{g}.json").write_text("{nope", encoding="utf-8")),
        S("activate over a live page that is not JSON", "activate", g, "@G", {}),
        FS("garb: live page removed", lambda r: remove_live(r, g)),
    ]
    big = {"sections": [{"id": "s1", "columns": [{"id": "c1", "width": 12, "widgets": [
        {"type": "text", "props": {"body": "x" * 2_200_000}}]}]}]}
    near = {"sections": [{"id": "s1", "columns": [{"id": "c1", "width": 12, "widgets": [
        {"type": "text", "props": {"body": "x" * 1_900_000}}]}]}]}
    steps += [
        S("block over 2 MiB", "add", g, body={"origin": "manual", "content": content(published=big)}),
        S("draft over 2 MiB", "add", g, body={"origin": "manual", "content": content(draft=big)}),
        S("two blocks of 1.9 MB (over 4 MiB together? no: 3.8 MB)", "add", g, body={
            "origin": "manual", "content": content(published=near, draft=near)}, save={"id": "N1"}),
        S("two blocks + title push the content over 4 MiB", "add", g, body={
            "origin": "manual", "content": content(published=near, draft=near, title={"en": "t" * 1500},
                                                   nav={"label": {"en": "n" * 1500}})}),
        S("delete N1", "delete", g, "@N1"),
    ]
    steps += [
        S("final list garb", "list", g),
        S("final list all", "list"),
    ]
    return steps


def nested(n):
    v = {"a": 1}
    for _ in range(n - 1):
        v = {"a": v}
    return v


def raw_live(root: Path, slug, text):
    d = root / "config" / "pages"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{slug}.json").write_text(text if isinstance(text, str) else json.dumps(text, indent=2), encoding="utf-8")
    private = root / "api" / "page-drafts" / f"{slug}.json"
    if private.exists():
        private.unlink()        # the file a hand edit writes has no private draft beside it


def review_steps():
    """What the review of the first version found twins disagreeing on."""
    ok = content(published=block("rv", "Review"))
    steps = []
    # depth: a bound of 64 containers per block, the same on both sides
    steps += [
        S("depth: exactly 64 is stored", "add", "rdeep", body={
            "origin": "manual", "content": content(published={"sections": [], "x": nested(63)})}),
        S("depth: 65 is refused", "add", "rdeep", body={
            "origin": "manual", "content": content(published={"sections": [], "x": nested(64)})}),
        S("depth: 300 is refused", "add", "rdeep", body={
            "origin": "manual", "content": content(draft={"sections": [], "x": nested(300)})}),
        S("depth: list still answers", "list", "rdeep"),
        S("depth: purge", "purge", "rdeep"),
    ]
    # a live page that fails the structural gate is still versioned, never refused
    steps += [
        FS("live: invalid columns", lambda r: raw_live(r, "rdmg", {
            "published": {"sections": [{"columns": "x"}]}, "schemaVersion": 2})),
        S("live: add + activate over an invalid live page snapshots it", "add", "rdmg", body={
            "origin": "manual", "content": ok, "activate": "publish"}, save={"id": "D1"}),
        FS("live: invalid columns again", lambda r: raw_live(r, "rdmg", {
            "published": {"sections": [{"columns": "x"}]}, "schemaVersion": 2})),
        S("live: update fromLive over an invalid live page", "update", "rdmg", "@D1", {"fromLive": True}),
        S("live: activating that version is refused (it holds a block the gate refuses)", "activate", "rdmg", "@D1", {}),
        S("live: list", "list", "rdmg"),
        FS("live: width 99", lambda r: raw_live(r, "rdmg", {
            "published": {"sections": [{"id": "s", "columns": [{"id": "c", "width": 99, "widgets": []}]}]},
            "schemaVersion": 2})),
        S("live: add + activate over a width 99 live page", "add", "rdmg", body={
            "origin": "manual", "content": content(published={"sections": [{"id": "s", "columns": [
                {"id": "c", "width": 12, "widgets": []}]}]}), "activate": "publish"}),
        S("live: purge", "purge", "rdmg"),
    ]
    # titles
    steps += [
        FS("title: live has a legacy string title", lambda r: raw_live(r, "rtitle", {
            "title": "Plain title", "published": block("lt", "Live"), "schemaVersion": 2})),
        S("title: add + activate (snapshot without the string title)", "add", "rtitle", body={
            "origin": "manual", "content": ok, "activate": "publish"}, save={"id": "T1"}),
        FS("title: live has a localized title", lambda r: raw_live(r, "rtitle", {
            "title": {"en": "Live X"}, "published": block("lx", "LX"), "schemaVersion": 2})),
        S("title: add a titled version", "add", "rtitle", body={
            "origin": "manual", "content": content(published=block("ty", "TY"), title={"en": "Y"})}, save={"id": "T2"}),
        S("title: activating it snapshots the live title", "activate", "rtitle", "@T2", {}),
        FS("title: live = title X over T1's blocks", lambda r: raw_live(r, "rtitle", {
            "title": {"en": "Live X"}, "published": block("rv", "Review"), "draft": block("rv", "Review"),
            "schemaVersion": 2})),
        S("title: activating the title-less T1 over it: no snapshot", "activate", "rtitle", "@T1", {}),
        S("title: update fromLive keeps the localized title", "update", "rtitle", "@T1", {"fromLive": True}),
        S("title: purge", "purge", "rtitle"),
    ]
    # the activation writes whenever a file would change, and only then
    steps += [
        FS("layout: live = the version, no private draft file", lambda r: raw_live(r, "rlay", {
            "published": block("rv", "Review"), "schemaVersion": 2})),
        S("layout: add", "add", "rlay", body={"origin": "manual", "content": content(published=block("rv", "Review"))},
          save={"id": "L1"}),
        S("layout: activate creates the private draft", "activate", "rlay", "@L1", {}),
        S("layout: activate again changes nothing", "activate", "rlay", "@L1", {}),
        FS("layout: live = the version, draft still inline, no schemaVersion", lambda r: raw_live(r, "rlay", {
            "published": block("rv", "Review"), "draft": block("rv", "Review")})),
        S("layout: activate normalizes it", "activate", "rlay", "@L1", {}),
        S("layout: purge", "purge", "rlay"),
    ]
    # sizes and shapes
    over = {"sections": [{"id": "s", "columns": [{"id": "c", "width": 12, "widgets": [
        {"type": "text", "props": {"body": "é" * 400000}}]}]}]}
    slashes = {"sections": [{"id": "s", "columns": [{"id": "c", "width": 12, "widgets": [
        {"type": "text", "props": {"body": "/" * 1100000}}]}]}]}
    steps += [
        S("size: 400000 two-byte characters (JSON escaping makes it oversize)", "add", "rsize", body={
            "origin": "manual", "content": content(published=over)}),
        S("size: 1.1 million slashes fit", "add", "rsize", body={
            "origin": "manual", "content": content(published=slashes)}),
        S("size: purge", "purge", "rsize"),
        S("shape: sections null + blocks", "add", "rshape", body={
            "origin": "manual", "content": content(published={"sections": None, "blocks": [{"type": "t"}]})}),
        S("shape: sections null alone", "add", "rshape", body={
            "origin": "manual", "content": content(published={"sections": None})}),
        S("shape: purge", "purge", "rshape"),
    ]
    # precedence between several bad fields, and a refused add leaves a damaged history alone
    steps += [
        FS("precedence: a damaged history", lambda r: put_history(r, "rprec", "{nope")),
        S("precedence: exportedAt bad + valid content", "add", "rprec", body={
            "origin": "capture", "exportedAt": 5, "content": ok}),
        S("precedence: label bad + mode bad", "add", "rprec", body={
            "origin": "capture", "label": 5, "activate": "bogus", "content": ok}),
        S("precedence: exportedAt bad + content bad", "add", "rprec", body={
            "origin": "capture", "exportedAt": 5, "content": {}}),
        S("precedence: mode bad + content bad", "add", "rprec", body={
            "origin": "capture", "activate": "bogus", "content": {}}),
        S("precedence: origin bad + everything bad", "add", "rprec", body={
            "origin": "x", "exportedAt": 5, "activate": "bogus", "content": {}}),
        S("precedence: purge", "purge", "rprec"),
    ]
    return steps


def put_history(root: Path, slug, text):
    d = root / "api" / "page-versions"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{slug}.json").write_text(text, encoding="utf-8")


def raw_version(i, **over):
    v = {"id": f"v{i:012x}", "label": f"Hand {i}", "note": "", "origin": "manual",
         "createdAt": "2026-11-19T10:00:00Z", "updatedAt": "2026-11-19T10:00:01Z", "exportedAt": "",
         "source": "", "platform": "", "content": {"published": block(f"r{i}", f"Raw {i}")}}
    v.update(over)
    return {k: x for k, x in v.items() if x is not ...}


def raw_history(slug, versions, indent=2, **over):
    d = {"schema": "lumen-page-versions/1", "slug": slug, "active": None, "versions": versions}
    d.update(over)
    return json.dumps(d, indent=indent, ensure_ascii=False)


def storage_steps():
    """Hand-made and damaged history files: what each backend reads, parks or refuses."""
    s = "store"
    ok = content(published=block("st", "Store"))
    add = {"origin": "capture", "content": ok}

    def history(name, text, *then):
        return [FS(f"store: {name}", lambda r, t=text: put_history(r, s, t)), *then]

    steps = []
    steps += history("not JSON", "{nope",
                     S("store: list a corrupt file", "list", s), S("store: get from a corrupt file", "get", s, "v000000000001"),
                     S("store: add over a corrupt file parks it", "add", s, body=add, save={"id": "ST1"}),
                     S("store: list after parking", "list", s))
    steps += history("a JSON list", "[1, 2]",
                     S("store: update over a list file", "update", s, "@ST1", {"label": "x"}),
                     S("store: add over a list file", "add", s, body=add))
    steps += history("empty file", "",
                     S("store: delete over an empty file", "delete", s, "v000000000001"),
                     S("store: activate over an empty file", "activate", s, "v000000000001", {}))
    steps += history("a newer schema", json.dumps({"schema": "lumen-page-versions/2", "slug": s, "versions": []}),
                     S("store: list a newer schema", "list", s), S("store: get a newer schema", "get", s, "v000000000001"),
                     S("store: add refused over a newer schema", "add", s, body=add),
                     S("store: update refused over a newer schema", "update", s, "v000000000001", {"label": "x"}),
                     S("store: activate refused over a newer schema", "activate", s, "v000000000001", {}),
                     S("store: delete refused over a newer schema", "delete", s, "v000000000001"),
                     S("store: purge removes a newer schema", "purge", s))
    steps += history("another slug inside", raw_history("other", [raw_version(1)]),
                     S("store: list a foreign slug", "list", s),
                     S("store: add over a foreign slug parks it", "add", s, body=add))
    steps += history("a repeated id", raw_history(s, [raw_version(1), raw_version(1, label="again")]),
                     S("store: list a repeated id", "list", s), S("store: delete over a repeated id", "delete", s, "v000000000001"))
    steps += history("an unknown origin", raw_history(s, [raw_version(1, origin="elsewhere")]),
                     S("store: get an unknown origin", "get", s, "v000000000001"))
    steps += history("a version with a bad id", raw_history(s, [raw_version(1, id="V000000000001")]),
                     S("store: list a bad id", "list", s))
    steps += history("a version whose content is a list", raw_history(s, [raw_version(1, content=[1])]),
                     S("store: list a content list", "list", s))
    steps += history("51 versions", raw_history(s, [raw_version(i + 1) for i in range(51)]),
                     S("store: list 51 versions", "list", s), S("store: add over 51 versions parks", "add", s, body=add))
    steps += history("versions is not a list", raw_history(s, {"a": 1}),
                     S("store: list versions object", "list", s))
    steps += history("hand written, lenient fields", raw_history(
        s, [raw_version(1, label=5, note=7, updatedAt=..., exportedAt=None, extra="dropped"),
            raw_version(2, label="", source=["x"], platform=3, createdAt=..., updatedAt=...),
            raw_version(3, content={"draft": block("r3", "Draft only"), "junk": 1, "title": {"en": "T"}})],
        active="v000000000002", extra=1),
        S("store: list hand written", "list", s), S("store: get hand written 1", "get", s, "v000000000001"),
        S("store: get hand written 2", "get", s, "v000000000002"),
        S("store: rename rewrites the file", "update", s, "v000000000001", {"label": "Renamed"}),
        S("store: delete the active one", "delete", s, "v000000000002"),
        S("store: delete another", "delete", s, "v000000000003"))
    steps += history("an unknown active id", raw_history(s, [raw_version(1)], active="v0000000000ff"),
                     S("store: list unknown active", "list", s),
                     S("store: delete is allowed (no active)", "delete", s, "v000000000001"))
    steps += history("4-space indent, compact", raw_history(s, [raw_version(1), raw_version(2)], indent=None),
                     S("store: add to a compact file", "add", s, body=add),
                     S("store: list", "list", s))
    steps += [S("store: purge", "purge", s), S("store: purge again", "purge", s)]
    return steps


def golden_steps():
    """The golden history the two twins are pinned to (tests/fixtures/page-versions), read and extended."""
    text = (ROOT / "tests" / "fixtures" / "page-versions" / "about.history.json").read_text(encoding="utf-8")
    g = SLUG_ABOUT
    return [
        S("golden: purge about", "purge", g),
        FS("golden: the fixture is the history of about", lambda r: put_history(r, g, text)),
        FS("golden: live about is the fixture's v1 content", lambda r: remove_live(r, g)),
        S("golden: list", "list", g),
        S("golden: get v1", "get", g, "v000000000001"),
        S("golden: get v3", "get", g, "v000000000003"),
        S("golden: rename v1", "update", g, "v000000000001", {"label": "Spring (renamed)"}),
        S("golden: activate v3 as draft (no live page: created)", "activate", g, "v000000000003", {"mode": "draft"}),
        S("golden: activate v1 publish", "activate", g, "v000000000001", {}),
        S("golden: add after the golden", "add", g, body={"origin": "manual", "content": content(published=block("gg"))},
          save={"id": "GG"}),
        S("golden: delete v3", "delete", g, "v000000000003"),
        S("golden: delete the active v1", "delete", g, "v000000000001"),
        S("golden: list at the end", "list"),
    ]


def scenario():
    return main_steps() + bulk_steps() + garbage_steps() + review_steps() + storage_steps() + golden_steps()


# ── normalisation and execution ─────────────────────────────────────────────────

_TS = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")
_ID = re.compile(r"\bv[0-9a-f]{12}\b")
_CORRUPT = re.compile(r"\.corrupt-\d{14}-[0-9a-f]{4}")
_TMP = re.compile(r"^\.tmp-[0-9a-f]+$")


class Aliases:
    def __init__(self):
        self.by_id = {}
        self.by_alias = {}
        self.auto = 0

    def register(self, real, alias):
        if real not in self.by_id:
            self.by_id[real] = alias
            self.by_alias[alias] = real

    def text(self, s):
        def sub(m):
            real = m.group(0)
            if real not in self.by_id:
                self.auto += 1
                self.register(real, f"<id#{self.auto}>")
            return self.by_id[real]
        return _TS.sub("<ts>", _ID.sub(sub, s))


def _pairs(pairs):
    return dict(pairs)   # key order is the insertion order


def _norm_json_text(raw: str, al: Aliases, sort_keys: bool) -> str:
    """The parsed document, written back with a fixed style ({} / [] kept; key order kept unless
    ``sort_keys``: a live page is the editor's document, whose key order nobody reads), masked."""
    try:
        doc = json.loads(raw, object_pairs_hook=_pairs)
    except ValueError:
        return al.text(raw)
    return al.text(json.dumps(doc, indent=1, ensure_ascii=False, sort_keys=sort_keys))


def snapshot_tree(root: Path, al: Aliases) -> dict:
    out = {}
    for sub in ("config/pages", "api/page-drafts", "api/page-versions"):
        d = root / sub
        if not d.is_dir():
            continue
        for f in sorted(d.iterdir()):
            name = f.name
            if _CORRUPT.search(name):
                # a parked file: the stamp and the random suffix are the server's, the content is what matters
                tag = hashlib.sha1(f.read_bytes()).hexdigest()[:6]
                name = _CORRUPT.sub(".corrupt-<" + tag + ">", name)
            if f.is_dir():
                out[f"{sub}/{name}/"] = "<dir>"
            elif _TMP.match(f.name) or f.name == ".migrated":
                out[f"{sub}/{name}"] = "<leftover>" if _TMP.match(f.name) else "<marker>"
            else:
                out[f"{sub}/{name}"] = _norm_json_text(f.read_text(encoding="utf-8"), al,
                                                     sort_keys=sub != "api/page-versions")
    return out


def norm_payload(obj, al: Aliases):
    def walk(v, key=None):
        if isinstance(v, dict):
            return {k: walk(x, k) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        if key == "rev" and isinstance(v, str) and re.fullmatch(r"[0-9a-f]{20}", v):
            return "<rev>"
        if key == "detail" and isinstance(v, str):
            return "<detail>"      # a diagnostic hint for the log: the wording is each backend's own
        if isinstance(v, str):
            return al.text(v)
        return v
    return walk(obj)


def _find_ids(payload):
    """The ids a response mentions, in document order."""
    ids = []

    def walk(v):
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, str) and _ID.fullmatch(v):
            ids.append(v)
    walk(payload)
    return ids


def run_scenario(steps, schedule, tmp: Path):
    """Run every step on a fresh tree; schedule(i) -> backend index. Returns (transcript, noise)."""
    tree = tmp
    (tree / "api").mkdir(parents=True, exist_ok=True)
    (tree / "config" / "pages").mkdir(parents=True, exist_ok=True)
    al = Aliases()
    transcript = []
    noise = []
    with python_tree(tree):
        backends = [PyBackend()]
        if PHP:
            backends.append(PhpBackend(tree, tmp))
        try:
            n = 0
            for step in steps:
                if step[0] == "fs":
                    step[2](tree)
                    transcript.append({"step": step[1], "tree": snapshot_tree(tree, al)})
                    continue
                _kind, name, action, params, body, save = step
                backend = backends[schedule(n) % len(backends)]
                n += 1
                real = {}
                for k, v in params.items():
                    if isinstance(v, str) and v.startswith("@"):
                        v = al.by_alias.get(v[1:], "v00000000dead")
                    real[k] = v
                raw = body if (body is None or isinstance(body, str)) else json.dumps(body)
                status, payload = backend.call(action, real, raw)
                payload = json.loads(json.dumps(payload))      # what a client receives
                for field, alias in save.items():
                    got = payload.get(field)
                    if isinstance(got, str) and _ID.fullmatch(got):
                        al.register(got, alias)
                    elif field == "id" and isinstance(payload.get("version"), dict):
                        pass
                for i in _find_ids(payload):
                    al.text(i)
                transcript.append({"step": name, "status": status, "payload": norm_payload(payload, al),
                                   "tree": snapshot_tree(tree, al)})
        finally:
            for b in backends:
                b.close()
                noise += getattr(b, "noise", [])
    return transcript, noise


def _dump(x):
    return json.dumps(x, indent=1, ensure_ascii=False, sort_keys=True).splitlines()


def diff_transcripts(a_name, a, b_name, b, limit=12):
    problems = []
    if len(a) != len(b):
        problems.append(f"{a_name} has {len(a)} steps, {b_name} has {len(b)}")
    for i, (x, y) in enumerate(zip(a, b)):
        xs = {k: v for k, v in x.items() if k != "tree"}
        ys = {k: v for k, v in y.items() if k != "tree"}
        parts = []
        if xs != ys:
            parts.append("ANSWER\n" + "\n".join(difflib.unified_diff(
                _dump(xs), _dump(ys), a_name, b_name, lineterm="", n=2)))
        if x.get("tree") != y.get("tree"):
            tx, ty = x.get("tree", {}), y.get("tree", {})
            for path in sorted(set(tx) | set(ty)):
                if tx.get(path) != ty.get(path):
                    parts.append(f"FILE {path}\n" + "\n".join(difflib.unified_diff(
                        (tx.get(path) or "<absent>").splitlines(), (ty.get(path) or "<absent>").splitlines(),
                        a_name, b_name, lineterm="", n=2)))
        if parts:
            problems.append(f"step {i} [{x['step']}]\n" + "\n".join(parts))
        if len(problems) >= limit:
            problems.append("... more steps differ")
            break
    return problems


@unittest.skipUnless(PHP, "php not available")
class PageVersionsParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.work = Path(tempfile.mkdtemp(prefix="lumen-pv-parity-"))
        steps = scenario()
        cls.runs = {}
        cls.noise = {}
        for name, schedule in (("py", lambda n: 0), ("php", lambda n: 1),
                               ("py/php", lambda n: n % 2), ("php/py", lambda n: (n + 1) % 2)):
            tmp = cls.work / name.replace("/", "-")
            tmp.mkdir()
            cls.runs[name], cls.noise[name] = run_scenario(steps, schedule, tmp)
        dump = os.environ.get("LUMEN_PV_PARITY_DUMP")
        if dump:
            Path(dump).mkdir(parents=True, exist_ok=True)
            for name, tr in cls.runs.items():
                (Path(dump) / (name.replace("/", "-") + ".json")).write_text(
                    json.dumps(tr, indent=1, ensure_ascii=False), encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.work, ignore_errors=True)

    def test_scenario_is_not_vacuous(self):
        py = self.runs["py"]
        by_name = {t["step"]: t for t in py}
        self.assertGreater(len(py), 400)
        self.assertEqual(by_name["add A + activate publish (live state not captured yet: safety snapshot)"]["status"], 200)
        self.assertIn("snapshotId", by_name["add A + activate publish (live state not captured yet: safety snapshot)"]["payload"])
        self.assertEqual(by_name["delete the active version"]["status"], 409)
        self.assertEqual(by_name["bulk add #51 refused"]["status"], 409)
        statuses = {t.get("status") for t in py}
        self.assertTrue({200, 400, 404, 409, 413} <= statuses, statuses)
        history = by_name["activate A restores the deleted page"]["tree"]
        self.assertIn("config/pages/about.json", history)
        self.assertIn("api/page-versions/about.json", history)

    def test_no_php_noise_and_no_leftovers(self):
        for name, noise in self.noise.items():
            self.assertEqual(noise, [], f"{name}: PHP warnings / stderr")
        for name, tr in self.runs.items():
            for t in tr:
                for path, text in t["tree"].items():
                    self.assertNotEqual(text, "<leftover>", f"{name}: {t['step']}: temp file {path} left behind")

    def test_php_answers_like_python(self):
        problems = diff_transcripts("py", self.runs["py"], "php", self.runs["php"])
        self.assertEqual(problems, [], "\n\n".join(problems))

    def test_entry_layer_agrees_on_a_malformed_body(self):
        """dev_server.py's do_POST (_pv_decode_body) and api/page-versions.php read a request body
        the same way: a body that is not JSON is 400 invalid_body on every write, and a JSON value
        that is not an object is refused by `activate` instead of being read as "no body" (which
        would publish with the defaults)."""
        ok = content(published=block("e", "Entry"))
        results = {}
        for name in ("py", "php"):
            tmp = self.work / f"entry-{name}"
            (tmp / "api").mkdir(parents=True)
            (tmp / "config" / "pages").mkdir(parents=True)
            with python_tree(tmp):
                backend = PyBackend() if name == "py" else PhpBackend(tmp, tmp)
                try:
                    _st, added = backend.call("add", {"slug": "entry"}, json.dumps({"origin": "capture", "content": ok}))
                    other = backend.call("add", {"slug": "entry"}, json.dumps({"origin": "capture", "content": ok}))[1]["id"]
                    got = []
                    for raw in ("[1]", '"x"', "{bad", "123", "true"):
                        got.append(backend.call("activate", {"slug": "entry", "id": added["id"]}, raw)[0])
                    got.append(backend.call("delete", {"slug": "entry", "id": other}, "{bad")[0])
                    got.append(backend.call("purge", {"slug": "entry"}, "{bad")[0])
                    for raw in ("", "null", "[]"):
                        got.append(backend.call("activate", {"slug": "entry", "id": added["id"]}, raw)[0])
                    results[name] = got
                finally:
                    backend.close()
        self.assertEqual(results["py"], [400] * 7 + [200] * 3)
        self.assertEqual(results["php"], results["py"])

    def test_python_then_php_reads_and_extends_the_others_history(self):
        problems = diff_transcripts("py", self.runs["py"], "py/php", self.runs["py/php"])
        self.assertEqual(problems, [], "\n\n".join(problems))

    def test_php_then_python_reads_and_extends_the_others_history(self):
        problems = diff_transcripts("py", self.runs["py"], "php/py", self.runs["php/py"])
        self.assertEqual(problems, [], "\n\n".join(problems))


if __name__ == "__main__":
    unittest.main()
