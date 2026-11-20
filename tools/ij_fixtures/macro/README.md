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
