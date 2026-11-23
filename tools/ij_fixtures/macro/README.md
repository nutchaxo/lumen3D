# ImageJ 1.54p macro-language oracle

Pure language conformance for the `.ijm` interpreter of the Advanced Studio: no image, no GUI,
no file. A corpus of small macros is run through the real `ij.macro.Interpreter` of
`ij-1.54p.jar` (headless, JDK 21) and the observable result is recorded in
`tests/fixtures/ij-macro/golden.json`. A JS interpreter is conformant when it reproduces every
entry (log lines, error text, error line, early exit).

Local only: never shipped (`tools/build_release.py` allowlists root dirs, `tools/` and `tests/`
are not among them), never run in CI. The jar stays outside the repo.

```
tools/ij_fixtures/macro/run_macro.sh <path/to/ij-1.54p.jar> [out.json [corpusDir]]
```

About 50 s for ~1250 cases (plus a few seconds for the log-window child JVM). Output is byte-reproducible (two runs give identical bytes; a run
over half of the corpus gives the same entries as the full run).

## Files

| File | Role |
|---|---|
| `MacroGolden.java` | Driver: walks `tests/fixtures/ij-macro/corpus/<group>/<case>.ijm` (sorted), runs each in its own class loader, writes `golden.json`; runs the `log-window` group again in a non-headless child JVM (`--log-window`). |
| `MacroProbe.java` | Lives in package `ij.macro` (the jar is not sealed) to read the package-private `Interpreter.lineNumber` / `errorMessage` that `showError` would only put in a dialog. Captures `System.out` and tags every line with the `ij.IJ` method that wrote it. `runLogWindow` installs a real `TextPanel` as the Log and returns its text. |
| `stub/ij/gui/GenericDialog.java` | Headless stand-in placed in front of the jar: `Interpreter.showError` builds a `GenericDialog` (a `HeadlessException` otherwise). Makes an error inside a nested macro (`eval`) observable. |
| `run_macro.sh` | Compiles to a temp dir (outside the repo) and runs. |
| `run_runtime.sh <jar>` | Regenerates `tests/fixtures/ij-macro/runtime-golden.json` from the image-model corpus `tests/fixtures/ij-macro/runtime/` (the same driver; `tests/js/test_ij_macro_pixels.mjs` compares the Studio with it). |
| `OptionsProbe.java` | Probe of `Macro.getValue` / `trimKey` / `GenericDialog` option parsing against the jar: writes `tests/fixtures/ij-macro/options-golden.json` (usage in its header; `tests/js/test_ij_macro_options.mjs`). |

## Why a class loader per case

ImageJ keeps state in statics (a "requires" message shown once, `List.*`, the random generator,
batch mode, the interpreter instance...). One JVM, many macros = order-dependent results (seen:
`requires` printed its message only for the first case of a run). `MacroGolden.runIsolated` loads
the jar again for every case, so each result depends on its own source only.

## golden.json

```
{ "<group>/<case>": {
    "log":    [ "line", ... ],                  // what print() / IJ.log() wrote, one entry per call
    "error":  null | { "message": "...", "line": n,
                       "excerpt": "...",        // the source line the error dialog shows (absent when silent)
                       "calledFrom": [k, ...],  // optional: the dialog's "(called from line k)" stack, innermost first
                       "silent": true },        // optional: see below
    "exited": true,                             // exit / exit("msg") ended the macro (not an error)
    "dialogs": [ { "kind", "text", "afterLog" } ],  // optional
    "logWindow": "..." | null                   // log-window group only: final text of the Log window
} }
```

* `error.message` is `Interpreter.errorMessage` (what the error dialog shows before " in line N").
  `line` is `Interpreter.lineNumber` at the error, 1-based; CRLF and a lone CR count as one break.
* The dialog ImageJ shows is `"<message> in line <line>\n" + stack + " \n" + excerpt`, where stack is
  one `"\t\t(called from line <k>)\n"` per entry of `calledFrom` and `excerpt` is the line re-spelled
  from its tokens (`a = 1 + <nope> ;`, the failing token in `< >`, cut at 119 chars + `...`).
* **`silent: true` (always with `line: 0`)**: the error was raised after the program had already run
  off its end (`Interpreter.done` set): an unclosed `{` or string, a trailing operator, a `requires`
  that failed inside a `macro` block, `return` inside a macro block... `Interpreter.error` then shows
  **no dialog and does not abort**: in Fiji the user sees nothing and the macro just stops. A port
  must not show an error window for these. (Not "tokenizer errors": the tokenizer reports nothing,
  the interpreter meets the end-of-program token, whose line is 0.)
* `log` is only what `IJ.log` wrote, raw: one entry per call, `"\\Clear"` and `"\\Update:"` included
  as text. Anything else headless ImageJ prints to stdout instead of opening a window goes to
  `dialogs`: `kind` is the `ij.IJ` method (`showMessage` for `exit("msg")`, `requires` too old,
  `showMessage()`; `error`...), or `errorDialog` for the error dialog of a **nested** macro
  (`eval`, same text as above). `afterLog` = number of `log` entries written before it.
* `logWindow` (group `log-window` only): that group runs a second time in a child JVM that is **not
  headless**, with a real `ij.text.TextPanel` installed as `IJ.logPanel` (never put in a window), so
  `IJ.log` applies ImageJ's own Log rules: `\\Clear`, `\\Update:`, `\\Update<n>:` (pads with empty
  lines), `\\Heading:` (column headings, not part of the text), `\\Closed` (drops the panel:
  `null`), `\\Close` (closes a Log frame: none here), `"\n"` splitting, and a trailing `"\n"` /
  `"\n\n"` turned into `" "` lines. It is the text `getInfo("log")` returns in Fiji (headless it
  returns `""`, hence the `log-window/getinfo-log` entry). This pass needs a desktop session.
* Java text that leaks from the JVM (`PatternSyntaxException`, `IllegalFormatConversionException`
  inside an error message) is recorded as is, except `System.lineSeparator()` normalised to `"\n"`
  (the golden does not depend on the OS); a port may match it loosely.
* `Locale.ROOT` is forced: `String.format` follows the JVM locale in Fiji (a French Fiji prints
  `3,14`); the golden, and the port, use the dot.
* A case that makes ImageJ print a Java stack trace (a headless artefact) makes the driver report
  `HEADLESS ARTIFACT` and count it as unexpected: rewrite or remove that case. The final line
  `unexpected java exceptions: 0` must stay 0 (the driver exits 3 otherwise; 2 = a case timed out).
  `call("ij.Prefs.set","nokey",v)` is not in the corpus for that reason: ImageJ logs the
  `IllegalArgumentException: Key must have a prefix` **with its Java stack trace** (driver frames
  included) and returns `"0"`.

## Corpus

`tests/fixtures/ij-macro/corpus/<group>/<case>.ijm`, UTF-8, byte-exact (`.gitattributes` there:
`* -text`; some cases carry CRLF, a lone CR, a BOM). Edited by hand, no generator: add a file,
rerun, read the new entry, keep it only if deterministic and image/GUI/file free.

Groups: `numbers-format` (print / d2s / toString sweeps), `operators`, `control`, `functions`,
`scope`, `arrays` (incl. `ExpandableArrays`), `strings` (incl. `String.*`, dot methods), `math`,
`list`, `errors` (incl. call stacks, multi-line statements, excerpts), `macro-blocks` (macro
blocks, `exit`, `requires`, `eval`, comments), `log-window` (Log commands, see `logWindow`),
`misc` (incl. the `call()` whitelist of `DOCS/studio-advanced/macros/CALL-WHITELIST.md`).

No `getTime`, `getDateAndTime`, unseeded `random()`, `getDirectory`, `File.*`, `open`, `run(...)`
(AWT menus: unusable headless).

Not covered here (needs another oracle): Fiji's `#@` script parameters. Fiji strips those lines
(`ParameterScriptProcessor`) and prepends `var` declarations before `ij.macro.Interpreter` sees the
text (REVIEW-external.md §1-2); plain ImageJ fails on them ("Unrecognized String function"), so a
case here would record the wrong behaviour for Fiji. Also absent: everything that needs an image,
a window, a file or the clock (`IJ.freeMemory/currentMemory/maxMemory` are machine-dependent).

## Dialog keys (`DialogKeys.java`)

What `run("Command", "key=value ...")` has to understand: for every ImageJ 1.54p command (all of `Menus.getCommands()`,
minus a deny list of file pickers, quitters and browsers) and for the Fiji commands the Studio maps, the dialog the **real
application** opens, walked with the public AWT / ImageJ API, written to `tests/fixtures/ij-macro/ij-dialogs.json` (ImageJ) and
`tests/fixtures/ij-macro/fiji-macro-keys.json` (Fiji). Consumed by `ij-macro-cmds.js` (written by hand from these files) and
cross-checked by `tests/js/test_ij_macro_capture.mjs`. Local only, never shipped, never in CI; needs a desktop session
(dialogs and image windows appear while it runs, about 20-40 minutes for the whole jar: leave the machine alone).

```
tools/ij_fixtures/macro/run_dialogkeys.sh ij <path/to/ij-1.54p.jar> [out.json] [--only "Name;Other name"]
tools/ij_fixtures/macro/run_dialogkeys.sh fiji [out.json]                      # env FIJI, default D:/APT/3A/BIOIMAGING/Fiji
node tools/ij_fixtures/macro/capture_coverage.mjs                              # Studio commands vs the captures
```

How a command is captured (`IJ.run(imp, name, null)` on its own thread, clean `user.home`, `Locale.ROOT`, ImageJ started non-headless
with `NO_SHOW`; a second image titled `other` is always open for the commands that ask for one):

1. The inputs are tried in this order until a command opens a `GenericDialog`: 8-bit + rectangle, 16-bit, 32-bit, binary, 2-channel
   composite, 8-bit + line, + point, 3-slice stack, RGB, 8-bit + oval, + polygon, 2c x 3z x 2t hyperstack (the recorded one is
   `input`). A command that neither opens a dialog nor complains on the first two inputs is only retried on the stack and on RGB.
2. A dialog is found by polling `Window.getWindows()`, walked in component order (labels, text fields typed by membership in
   `getNumericFields()` / `getStringFields()`, sliders, checkboxes, `CheckboxGroup`s, choices with their items and selection,
   text areas, messages, custom buttons), then closed with **OK** (defaults), so a multi-dialog command reaches its next dialog.
   A "Process all N images?" `YesNoCancelDialog` is answered Yes, recorded as `processStack: true` on the dialog before it with the
   question in `processQuestion` (asked only for a stack, hence one extra run on the stack input when the first input did not ask).
3. **Keys**: `GenericDialog.saveLabel` (the `Macro.trimKey` of the label plus the `_0`, `_1` duplicate suffix) only runs while
   `Recorder.record` is on, so the capture turns it on (a hidden `Recorder` instance is installed) and reads the dialog's private
   `labels` table by reflection: the keys are the jar's own, including the ones that differ from the displayed label (ImageJ shows `_`
   as a space but keeps it in the key: `pixel_width`; such components carry `"underscored": true`). A component the plugin never
   registered (the Preview checkbox of a filter) has `key: null`; text areas are `text1` / `text2`; a file / directory field is its text field.
4. **Cross-check**: the Recorder's own text of the run (default values, only ticked checkboxes, `[..]` around spaces) is `recorded`
   (single-dialog commands: the whole option string; several dialogs: each dialog's share of `Recorder.getCommandOptions()`, plus
   `recordedAll` on the first). A command recorded as a call (`imageCalculator(...)`) has `recordedCall`.
5. Messages shown instead of a dialog ("8-bit grayscale image required", ...) are listed in `messages` (ImageJ's own text; useful for
   `disabledText`). A command that ran with no dialog is `noDialog`, one that could not be captured is `skipped` with the reason
   (deny list: file pickers, installs, quit, browser, windows that need clicks; or it did not finish within 12 s).

Fiji: the GenericDialog commands go through the same walker against Fiji's own jars and Java; the SciJava command (Frangi
Vesselness) has no dialog to open, its `components` come from the `@Parameter` names of its `ModuleInfo` (`FijiScijava.java`, `kind: "other"`,
key = parameter name). Public API only, no Fiji code is read or copied.

`ij-dialogs.json` schema: see `DOCS/studio-advanced/macros/INTEGRATION.md` section 5.5 (extra optional fields: `input.id`, `underscored`,
`unrecognized` on a component, `scale` of a slider, `units` of a numeric field, `buttons` of a dialog, `recordedAll`, `recordedCall`,
command-level `processQuestion`, `messages`, `opensWindow`, top-level `blackBackground`).

## Files golden: the file functions (`FileGolden.java`, `FileProbe.java`, `run_files.sh`)

The file functions of the macro language run against **real files**, through the real `ij-1.54p.jar`: `File.*`, `getFileList`,
`open`, `save`, `saveAs`, `runMacro`, `Table.open/save`, `roiManager("open"/"save")`, `IJ.checksum`, and the `run("...")` commands that
read or write a file. The result of every case is recorded in `tests/fixtures/ij-macro/files-golden.json`; the virtual file system of
the Studio (`ij-macro-vfs.js`, contract `DOCS/studio-advanced/macros/FILES.md`, section 15) must reproduce it. Local only, never
shipped, never in CI; **needs a desktop session** for most cases (see "Two environments").

```
tools/ij_fixtures/macro/run_files.sh <path/to/ij-1.54p.jar>                 # writes tests/fixtures/ij-macro/files-golden.json (about 5 min)
tools/ij_fixtures/macro/run_files.sh <path/to/ij-1.54p.jar> --make-inputs   # rewrites the images / archives of <case>/in/ from <case>/setup.ijm
tools/ij_fixtures/macro/run_files.sh <path/to/ij-1.54p.jar> out.json [filesDir]
IJM_ONLY='open/' tools/ij_fixtures/macro/run_files.sh ...                    # only the cases whose name contains this (a trailing $ = exact name)
```

| File | Role |
|---|---|
| `FileGolden.java` | Driver: walks `tests/fixtures/ij-macro/files/<group>/<case>/`, prepares the granted folder, runs every macro in a JVM of its own, reads the final tree back, writes the golden. |
| `FileProbe.java` | Lives in package `ij.macro` (the jar is not sealed), like `MacroProbe`: reads the package-private `Interpreter.errorMessage` / `lineNumber`, overrides `finishUp()` to see the images before ImageJ drops them, hooks the Log and the dialogs on a desktop run, computes the pixel digest. |
| `run_files.sh` | Compiles to a temp dir (outside the repo), clean `user.home`, `-Duser.timezone=UTC -Duser.language=en -Duser.country=US`, runs. |

### Corpus

`tests/fixtures/ij-macro/files/<group>/<case>/`

| File | Role |
|---|---|
| `macro.ijm` | The macro. `{ROOT}` stands for the granted folder **with its trailing `/`**; on both sides it expands to `/ijm-vfs-golden/`. Every case prints what it checks. |
| `in/` | The input tree, copied into the (emptied) granted folder before the run; byte-exact (`.gitattributes`: `* -text`). Empty folders cannot be committed: a case that needs one makes it in the macro. |
| `setup.ijm` | Optional. The jar writes the images / archives / LUTs / ROIs of `in/` (run by `--make-inputs`, `{ROOT}` = the folder that becomes `in/`). Hand-made files (text, raw bytes, a hand-built ZIP) are committed in `in/` directly. All images are at most 32 x 32 px; the whole corpus is well below 3 MB. |
| `case.json` | Optional: `{ "gui": true }` (needs a desktop, see below), `{ "mtime": { "<rel>": ms } }` (default for every input: `1700000000000`). |

Groups: `file` (every `File.*` member, writers, `File.open/print/close`), `list` (`getFileList`), `open` (every format the Studio decodes,
`open(path, n)`, errors, `run("Open...")`), `save` (`save`, `saveAs` per format, extension rules, `run("Save")`), `runcmd` (the file commands
of `run()` with their option keys), `table` (`Table.save/open`, `Results... `), `roi` (`roiManager open/save`), `macro` (`runMacro`,
`run("Run...")`, `IJ.checksum`).

### The granted folder

The folder is the real directory `/ijm-vfs-golden/` of the drive of the current directory (`run_files.sh` starts in the repository),
emptied before every case and removed at the end. The runner touches it only when it does not exist or when the marker file
`/ijm-vfs-golden.marker` sits beside it (it refuses otherwise, so a real folder of that name is never wiped). On Linux / macOS the
root of the file system must be writable.

### Two environments (one JVM per case)

ImageJ keeps statics (messages shown once, batch mode, the last directory of `OpenDialog`, and the macro file writer that a failed macro
never closes: its file would stay locked), so every case runs in a JVM of its own (`FileGolden --case`).

* **Headless** (no `case.json`): `java.awt.headless=true`, no ImageJ instance, `IJ.log` / `IJ.showMessage` print to stdout (what
  `MacroGolden` does). The headless `GenericDialog` stand-in (`stub/`) makes the error box of a failed macro observable. Used by the pure
  `File.*` / `getFileList` cases.
* **Desktop** (`"gui": true`): `-Djava.awt.headless=false` and a running `new ImageJ(ImageJ.NO_SHOW)`, which is what Fiji is: `run("...")`
  needs the AWT menus table (headless it ends in a `HeadlessException`), `open()` of a table needs the Results window, `selectWindow("Log")`
  needs the Log window. `FileProbe` makes the Log window itself (hidden) with a recording panel, so every `IJ.log` call is a `log` entry
  (the text `IJ.log` was given: it appends a space to a text ending in a line break, undone here, as in the headless record).
  Every modal dialog is recorded and closed by a daemon thread (`DialogKeys` does the same): the macro error box (`Macro Error`,
  `No Image`), a message box (`kind: "error"` when the macro thread is inside `IJ.error`, else `showMessage`, with its **exact title**), and a
  file chooser, which makes the runner stop (`NOT A GOLDEN`): no golden case may open a picker. Windows flash on the screen while it runs;
  leave the machine alone.

The headless titles of message boxes (none in the current corpus) are read from the 1.54p source line of the caller
(`DOCS/studio-advanced/macros/ij-src/`).

### `files-golden.json`

Schema of FILES.md 15.3, sorted cases, UTF-8, no clock: two runs give identical bytes (checked).

```
{ "imagej": "1.54p", "generator": "tools/ij_fixtures/macro/FileGolden.java", "root": "/ijm-vfs-golden/", "tz": "UTC",
  "cases": { "<group>/<case>": {
    "log": [string],                  // one entry per IJ.log call
    "error": null | { "message", "line", "silent"? },   // the macro error (Interpreter.errorMessage / lineNumber); silent = raised after the program ended
    "exited": true?,                  // the macro ended by Macro.abort (a dialog, then stop: no macro error)
    "dialogs": [ { "kind": "showMessage" | "error", "title", "text", "afterLog" } ],   // boxes other than the macro error box
    "tree": [ { "path": "<rel>" | "<rel>/", "size", "cmp": "bytes" | "pixels" | "zipEntries" | "dims" | "exists", ... } ],
    "images": [ { "title", "pixels", "dir", "filename" } ] } } }   // images alive at the end (batch images and window images; none after a macro error)
```

* `tree`: the final contents of the folder (the folder itself excluded), sorted by `path` (UTF-16 order), folders as `"<rel>/"` with
  `cmp: "exists"`. `cmp` by extension: `.tif .tiff .png .gif .bmp` -> `pixels` (decoded by the jar's `Opener`); `.jpg .jpeg` -> `dims` (only
  `w`, `h`, `bitDepth` bind: the `sha256` of a lossy file is the jar's own encoder); `.zip` -> `zipEntries` (entry names and SHA-256 of the
  uncompressed bytes, sorted by name); anything else -> `bytes` (`sha256`). In text files (`.txt .csv .tsv .xls .ijm .java .html .htm
  .json .md .log`) `CR LF` is turned into `LF` before hashing and measuring. **`size` is the file size on the jar's disk and binds only for
  `bytes` and `exists`**: a PNG / TIFF / ZIP / JPEG written by another encoder has another size.
* `pixels`: `{w, h, c, z, t, bitDepth, sha256}`, `sha256` = SHA-256 of the ASCII header `w,h,c,z,t,bitDepth` + `LF`, then every plane in stack
  order (c fastest, then z, then t): 8-bit bytes, 16-bit little-endian, 32-bit little-endian IEEE bits, RGB as R, G, B bytes.
* `images[].dir` / `filename` are the `FileInfo` of the opened file (`""` for an image made by the macro).
* Normalisation of every recorded string: `CR LF` -> `LF`, backslash -> `/`, `<drive>:/ijm-vfs-golden` -> `/ijm-vfs-golden`, and the Windows
  wordings of I/O errors -> the POSIX ones (`No such file or directory`, `Permission denied`, `Invalid argument`; English **and French**, the
  language of the OS that records). Time zone UTC, `Locale.ROOT`, `-Duser.language=en`.

### What depends on the platform that recorded it

The golden is recorded on Windows. A VFS that models the macro "on a non-Windows system" must expect these differences in the *jar's*
behaviour, not in the Studio's:

* `file/rename-onto-existing`: `File.renameTo` over an existing file answers `0` on Windows; on Linux / macOS it replaces the file.
* `file/copy-bad-destination`: the message of `Tools.copyFile` is the bare OS reason (`No such file or directory` after normalisation);
  on Linux the Java exception text may carry the path.
* Names ordered by `getFileList`: sorted by the jar (`Arrays.sort`, case-sensitive); corpus names are lower-case ASCII. The mixed-case order
  and `Thumbs.db` against `thumbs.db` (NTFS cannot hold both) are unit tests of the VFS.
* A macro that leaves a file open on a **macro error** (`file/writer-error-open`, `file/writer-twice`): ImageJ never closes the writer
  of an aborted macro, so the bytes written so far (they sit in a buffer) are lost: the file is **empty**. A macro that ends normally closes
  it (`file/writer-unclosed`).
* Line endings written by `print(f, ...)` are the platform's (`CR LF` on Windows); the tree normalises them.

### Adding a case

Write `files/<group>/<case>/macro.ijm` (+ `in/`, or a `setup.ijm` and `--make-inputs`), add `case.json` `{ "gui": true }` if it fails with a
`HeadlessException`, run it alone (`IJM_ONLY='group/case$'`), read the entry, keep it only when it is deterministic and opens no picker.
A case that prints a machine path, a time, or a Java exception with a stack is rewritten. The final line `unexpected: 0` must stay 0.
