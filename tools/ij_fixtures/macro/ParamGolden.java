import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.scijava.Context;
import org.scijava.module.ModuleItem;
import org.scijava.prefs.PrefService;
import org.scijava.script.ScriptInfo;
import org.scijava.script.ScriptModule;
import org.scijava.script.ScriptService;

/**
 * `#@` script parameters as Fiji runs them (ImageJ 2.18.0, imagej-legacy 3.0.0, scijava-common 2.101.0, ij 1.54p): for every case of
 * the corpus, the inputs / outputs SciJava parses (public ModuleInfo / ModuleItem getters, plus DefaultWidgetModel.getWidgetLabel for
 * the label a dialog shows), then runs through ScriptService.run(file, true, inputs) with the IJ1 macro engine: the Log (print goes to
 * stdout in headless Fiji), the Macro Error text, the outputs map, SciJava's warnings. Writes tests/fixtures/ij-macro/params-golden.json
 * and the case scripts to tests/fixtures/ij-macro/params/<id>.ijm. Contract: DOCS/studio-advanced/macros/EXTRAS.md section 14.3.
 *
 * The source the IJ1 engine actually runs is observed with ImageJ's own public API: a second run of the case with
 * `call("ParamGolden.dump");` on an extra last line makes the running ij.macro.Interpreter list its tokenized program (tokens per
 * line, numbers as the exact double the tokenizer holds, strings as their decoded text). No Fiji / SciJava source is read or copied:
 * everything comes from running the public API.
 *
 * Usage: ParamGolden <outDir (tests/fixtures/ij-macro)> <scratchDir>   (run_extras.sh params: Fiji's jars and JDK, headless)
 * Local only, never CI.
 */
public class ParamGolden {
    static { net.imagej.patcher.LegacyInjector.preinit(); }

    static final class Run {
        final Map<String, Object> inputs; String source; String note;
        Run(Map<String, Object> inputs) { this.inputs = inputs; }
        Run source(String s) { source = s; return this; }
        Run note(String n) { note = n; return this; }
    }
    static final class Case {
        final String id, source; final List<Run> runs = new ArrayList<>(); String note; final Map<String, String> files = new LinkedHashMap<>();
        boolean image;
        Case(String id, String source) { this.id = id; this.source = source; }
        Case run(Object... kv) { runs.add(new Run(Kit.map(kv))); return this; }
        Case run(Run r) { runs.add(r); return this; }
        Case note(String n) { note = n; return this; }
        Case file(String name, String text) { files.put(name, text); return this; }
        Case image() { image = true; return this; }
    }

    static final String IMAGE = "<image>";
    static final List<Case> CASES = new ArrayList<>();
    static Case add(String id, String src) { Case c = new Case(id, src); CASES.add(c); return c; }

    static {
        add("int-default", "#@ Integer (value=5) n\nprint(n); print(n+1);\n").run("n", 3).run();
        add("int-min-max", "#@ Integer (min=1, max=10, value=3) n\nprint(n);\n").run("n", 7).run("n", 42).note("Fiji does not clamp a value given programmatically");
        add("int-slider", "#@ Integer (style=\"slider\", min=0, max=100, stepSize=5, value=20) n\nprint(n);\n").run("n", 35);
        add("int-spinner", "#@ Integer (style=\"spinner\", min=-5, max=5) n\nprint(n);\n").run("n", -2);
        add("int-scrollbar", "#@ Integer (style=\"scroll bar\", min=0, max=255, value=128) n\nprint(n);\n").run("n", 200);
        add("long", "#@ Long l\nprint(l); print(d2s(l,0));\n").run("l", 123456789012L);
        add("short", "#@ Short s\nprint(s);\n").run("s", (short) -300);
        add("byte", "#@ Byte b\nprint(b);\n").run("b", (byte) -5);
        add("float-format", "#@ Float (style=\"format:0.000\", value=1.5) f\nprint(d2s(f,12)); if (f==0.1) print(\"exact\"); else print(\"float\");\n").run("f", 0.1f);
        add("double-step", "#@ Double (stepSize=0.25, min=0, max=2, value=0.5) d\nprint(d);\n").run("d", 1.75);
        add("biginteger", "#@ BigInteger bi\nprint(bi); print(d2s(bi,0));\n").run("bi", new java.math.BigInteger("12345678901234567890"));
        add("bigdecimal", "#@ BigDecimal bd\nprint(bd); print(d2s(bd,4));\n").run("bd", new java.math.BigDecimal("0.30"));
        add("primitives", "#@ int i\n#@ double d\n#@ boolean b\n#@ float f\n#@ long l\nprint(i+\" \"+d+\" \"+b+\" \"+f+\" \"+l);\n")
            .run("i", 2, "d", 2.5, "b", true, "f", 1.25f, "l", 7L);
        add("string-plain", "#@ String s\nprint(s); print(lengthOf(s));\n").run("s", "hello world");
        add("string-choices", "#@ String (choices={\"alpha\",\"beta gamma\",\"delta\"}) s\nprint(s);\n").run("s", "beta gamma").run();
        add("string-listbox", "#@ String (choices={\"a\",\"b\"}, style=\"listBox\") s\nprint(s);\n").run("s", "b");
        add("string-radio-h", "#@ String (choices={\"one\",\"two\"}, style=\"radioButtonHorizontal\", value=\"two\") s\nprint(s);\n").run("s", "one").run();
        add("string-radio-v", "#@ String (choices={\"x\",\"y\",\"z\"}, style=\"radioButtonVertical\") s\nprint(s);\n").run("s", "z");
        add("string-textarea", "#@ String (style=\"text area\", rows=4, columns=30, value=\"line1\") t\nprint(t);\n").run("t", "a\nb");
        add("string-password", "#@ String (style=\"password\") pw\nprint(lengthOf(pw));\n").run("pw", "secret");
        add("string-choices-unknown", "#@ String (choices={\"a\",\"b\"}) s\nprint(s);\n").run("s", "c").note("a value outside the choices, given programmatically");
        add("boolean", "#@ Boolean (value=true) b\nprint(b); if (b) print(\"yes\"); else print(\"no\");\n").run("b", false).run();
        add("file-open", "#@ File (style=\"open\") f\nprint(f);\n").run("f", new File("C:/data/in put/a.tif"));
        add("file-save", "#@ File (style=\"save\") f\nprint(f);\n").run("f", new File("C:/data/out.tif"));
        add("file-directory", "#@ File (style=\"directory\") d\nprint(d);\n").run("d", new File("C:/data/folder"));
        add("file-extensions", "#@ File (style=\"extensions:png/tif\") f\nprint(f);\n").run("f", new File("C:/data/a.png"));
        add("file-quote", "#@ File f\nprint(f); print(lengthOf(f));\n").run("f", new File("C:/da\"ta/x'y.tif"));
        add("file-array", "#@ File[] fs\nprint(fs);\n").run().note("headless Fiji asks a UI for the file list: the run fails");
        add("color", "#@ ColorRGB (value=\"red\") c\nprint(c);\n").run().run("c", new org.scijava.util.ColorRGB(10, 20, 30));
        add("imageplus", "#@ ImagePlus imp\nprint(imp); print(getTitle()); if (getImageID()==imp) print(\"current\");\n").image().run("imp", IMAGE).run();
        add("imageplus-none", "#@ ImagePlus imp\nprint(imp);\n").run().note("no image open");
        add("dataset", "#@ Dataset ds\nprint(ds); print(getTitle());\n").image().run().run("ds", IMAGE);
        add("imgplus", "#@ ImgPlus ip\nprint(ip);\n").image().run();
        add("vis-message", "#@ String (visibility=MESSAGE, value=\"Read me first\") msg\n#@ Integer n\nprint(n); print(msg);\n").run("n", 1);
        add("vis-message-noval", "#@ String (visibility=MESSAGE) msg\nprint(\"ran\");\n").run();
        add("vis-invisible", "#@ Integer (visibility=INVISIBLE, value=7) hidden\nprint(hidden);\n").run().run("hidden", 9);
        add("vis-transient", "#@ Integer (visibility=TRANSIENT, value=2) t\nprint(t);\n").run("t", 8).run();
        add("label-description", "#@ Integer (label=\"My number\", description=\"Help text\") n\n#@ Integer count\n#@ String fooBar\n#@ String (label=\"\") empty\nprint(n+\" \"+count+\" \"+fooBar);\n")
            .run("n", 1, "count", 2, "fooBar", "z", "empty", "");
        add("persist-default", "#@ Integer (value=5) pa\nprint(pa);\n").run("pa", 7).run().note("persist defaults to true: the second run, given no value, gets the first run's");
        add("persist-false", "#@ Integer (value=5, persist=false) pb\nprint(pb);\n").run("pb", 7).run();
        add("persist-shared-name", "#@ Integer (value=5) shared\nprint(\"A \"+shared);\n").run("shared", 11)
            .run(new Run(Kit.map()).source("#@ Integer (value=6) shared\nprint(\"B \"+shared);\n").note("another script with an input of the same name"))
            .note("persisted values are keyed by the input's name, not by the script");
        add("persist-key", "#@ Integer (value=5, persistKey=\"myKey\") pk\nprint(pk);\n").run("pk", 13).run();
        add("required-false", "#@ String (required=false) s\n#@ Integer (required=false) n\nprint(\"[\"+s+\"] \"+n);\n").run();
        add("required-default-missing", "#@ String s\n#@ Integer n\nprint(\"[\"+s+\"] \"+n);\n").run().note("no value, no default, headless");
        add("callback", "#@ Integer (callback=\"cb\", value=1) n\nprint(n);\nfunction cb() { print(\"callback ran\"); }\n").run("n", 4);
        add("autofill-false", "#@ ImagePlus (autoFill=false) imp\nprint(imp);\n").image().run();
        add("columns-rows", "#@ String (columns=12) s\nprint(s);\n").run("s", "x");
        add("initializer", "#@ Integer (initializer=\"init\") n\nprint(n);\n").run("n", 3);
        add("output-string", "#@ String name\n#@output String greeting\ngreeting = \"Hello \" + name;\n").run("name", "Ann");
        add("output-number", "#@output Double r\n#@output Integer k\n#@output Double whole\nr = 1.5; k = 3; whole = 2;\n").run();
        add("output-unset", "#@output String never\nprint(\"no assignment\");\n").run();
        add("output-array", "#@output String arr\narr = newArray(1, 2, 3);\n").run();
        add("output-both", "#@both Integer n\nn = n * 2;\nprint(n);\n").run("n", 21);
        add("output-io-space", "#@output Integer out1\n#@ output Integer out2\nout1 = 1; out2 = 2;\n").run();
        add("implicit-result", "print(\"x\");\nreturn \"retval\";\n").run();
        add("implicit-result-var", "result = 42;\n").run();
        add("implicit-result-number", "return 3.5;\n").run();
        add("implicit-with-output", "#@output String o\no = \"set\";\nreturn \"r\";\n").run();
        add("legacy-comment", "// @Integer n\n// @String(value=\"x\") s\nprint(n+s);\n").run("n", 4, "s", "y");
        add("legacy-comment-space", "// @ Integer n\n//@Integer m\nprint(n+m);\n").run("n", 1, "m", 2);
        add("name-with-dash", "#@ Integer my-n\n#@ Integer ok_1\nprint(ok_1);\n").run("my-n", 3, "ok_1", 4);
        add("name-with-dot", "#@ Integer a.b\n#@ Integer c\nprint(c);\n").run("a.b", 3, "c", 5);
        add("name-builtin", "#@ Integer print\n#@ String getTitle\n#@ Integer x\n#@ Integer PI\nprint(x);\n").run("print", 1, "getTitle", "t", "x", 3, "PI", 4)
            .note("input names that are built-in macro functions or constants");
        add("service-ui","#@ UIService ui\nprint(ui);\n").run();
        add("service-log", "#@ LogService log\nprint(\"ok\");\n").run();
        add("service-context", "#@ Context ctx\nprint(\"ok\");\n").run();
        add("service-command", "#@ CommandService cs\nprint(\"ok\");\n").run();
        add("quote-escaping", "#@ String s\nprint(s); print(lengthOf(s));\n").run("s", "a\"b\\c\nd\te\u00e9");
        add("quote-unicode-ctl", "#@ String s\nprint(lengthOf(s)); print(charCodeAt(s, 1));\n").run("s", "x\u0001y");
        add("number-format", "#@ Double a\n#@ Double b\n#@ Double c\n#@ Double d\n#@ Double f\n"
            + "if (a==1e-10) print(\"a exact\"); print(b); print(c); print(d); print(f); print(1/f);\n")
            .run("a", 1e-10, "b", 0.1, "c", 3.0, "d", Double.NaN, "f", -0.0);
        add("number-infinity", "#@ Double e\nprint(e);\n").run("e", Double.POSITIVE_INFINITY).run("e", Double.NEGATIVE_INFINITY);
        add("number-big", "#@ Double a\n#@ Integer b\nprint(a); print(b);\n").run("a", 1.5e300, "b", Integer.MIN_VALUE);
        add("line-numbers", "#@ Integer n\n#@ String s\nx = undefinedThing;\n").run("n", 1, "s", "a");
        add("prefix-excerpt", "print(a); z = q;\n#@ Integer a\n#@ String b\n").run("a", 2, "b", "x");
        add("prefix-excerpt-none", "z = q;\n").run().note("no parameter at all");
        add("script-header", "#@script(name=\"Hello\", label=\"Hi there\", menuPath=\"Plugins>X\")\n#@ Integer n\nprint(n);\n").run("n", 1);
        add("script-header-space", "#@ script (name=\"Spaced\")\nprint(\"ok\");\n").run();
        add("attr-spacing-1", "#@Integer(value=3)n\nprint(n);\n").run();
        add("attr-spacing-2", "#@ Integer n (value=3)\nprint(n);\n").run();
        add("attr-spacing-3", "#@ Integer ( value = 3 , min = 1 ) n\nprint(n);\n").run();
        add("attr-spacing-4", "#@   Integer    n\nprint(n);\n").run("n", 9);
        add("attr-spacing-5", "#@Integer n\nprint(n);\n").run("n", 8);
        add("attr-spacing-6", "#@ Integer(value=3) n\nprint(n);\n").run();
        add("attr-spacing-7", "  #@ Integer n\nprint(n);\n").run("n", 6).note("indented line");
        add("attr-bare-values", "#@ String (value=abc, label=Some label) s\nprint(s);\n").run();
        add("attr-unknown", "#@ Integer (foo=\"bar\", value=4) n\nprint(n);\n").run();
        add("attr-quoted-escape", "#@ String (value=\"say \\\"hi\\\"\") s\nprint(s);\n").run();
        add("duplicate-name", "#@ Integer n\n#@ String n\nprint(n);\n").run("n", "zz");
        add("unknown-type", "#@ Foo x\nprint(1);\n").run();
        add("char", "#@ Character ch\n#@ char c2\nprint(ch+c2);\n").run("ch", 'q', "c2", 'r');
        add("date", "#@ Date d\nprint(\"ran\");\n").run();
        add("own-var-collision", "#@ Integer a\nvar a = 7;\nprint(a);\n").run("a", 3);
        add("own-var-later", "#@ Integer a\nprint(a);\nvar a = 7;\n").run("a", 3);
        add("own-function", "#@ Integer a\nprint(a);\nfunction initializeSciJavaParameters() { print(\"mine\"); }\n").run("a", 3);
        add("macro-block", "#@ Integer a\nmacro \"Main\" {\n  print(a);\n}\n").run("a", 3);
        add("nested-runmacro", "print(\"outer\");\nrunMacro(\"{DIR}child.ijm\", \"arg\");\nprint(\"back\");\n")
            .file("child.ijm", "#@ Integer (value=4) n\nprint(\"child \"+n+\" \"+getArgument());\n").run();
        add("nested-runmacro-persisted", "print(\"outer\");\nrunMacro(\"{DIR}child2.ijm\");\n")
            .file("child2.ijm", "#@ Integer (value=4) cn\nprint(\"child \"+cn);\n").run()
            .run(new Run(Kit.map("cn", 9)).source("#@ Integer cn\nprint(\"direct \"+cn);\n").note("a direct run that persists cn = 9"))
            .run();
        add("no-params", "print(\"plain\");\n").run();
        add("no-final-newline", "#@ Integer n\nprint(n); y = 1 +").run("n", 2).note("the script ends without a line break, inside an expression");
        add("final-blank-lines", "#@ Integer n\nprint(n);\n\n\nz = q;").run("n", 2);
        StringBuilder many = new StringBuilder();
        List<Object> kv = new ArrayList<>();
        for (int i = 1; i <= 14; i++) { many.append("#@ Integer v").append(i).append("\n"); kv.add("v" + i); kv.add(i); }
        many.append("print(v1+v2+v3+v4+v5+v6+v7+v8+v9+v10+v11+v12+v13+v14);\n");
        add("many-inputs", many.toString()).run(kv.toArray()).note("14 inputs: the order of the var list and of the assignments past 12 names");
        add("crlf", "#@ Integer n\r\n#@ String s\r\nprint(n+s);\r\nx = q;\r\n").run("n", 1, "s", "b");
    }

    /** What the cases show, in words (each item names the cases it rests on). Checked by hand against the recorded data. */
    static final List<Object> FINDINGS = List.of(
        "Line 1 of the program starts with `var <names>; initializeSciJavaParameters();` before the script's own first line: every input name followed by a comma, even the last (tokens `var a , b , ;`), `var ;` when there is none (int-default, primitives, no-params, prefix-excerpt-none)",
        "Names are listed, and assigned, in java.util.HashMap iteration order of the input names (bucket = (h ^ h>>>16) & (capacity-1), h = String.hashCode, capacity 16 doubled past 0.75 load; insertion order within a bucket) - not declaration order (label-description, primitives, many-inputs)",
        "The `#@` lines are emptied in place (line numbers unchanged: error lines are source lines) (line-numbers, crlf, final-blank-lines)",
        "After the script: one line break when the script does not end with one, then a blank line, then `function initializeSciJavaParameters() {`, `call(\"net.imagej.legacy.plugin.IJ1MacroEngine.saveInterpreter\");`, one `name = value;` line per input that has a value, `}` (int-default, no-final-newline, final-blank-lines)",
        "Values: numbers as the exact double (Integer 3 -> 3, Float 0.1f -> 0.1, Long/BigInteger as doubles; a negative value is `-` then the number); NaN -> NaN; Infinity -> the identifier Infinity, an `Undefined variable` error at its line (number-format, number-infinity, float-format, biginteger, number-big)",
        "Boolean -> true / false; String, Character, File (absolute path, OS separators), ColorRGB (`r,g,b`), Dataset (its title), services and other objects (their toString) -> a string literal holding the exact text (quote-escaping, quote-unicode-ctl, file-*, color, dataset, imgplus, service-ui)",
        "ImagePlus -> its image ID (a negative number); with no value given, the current image (imageplus); none open -> the run is canceled",
        "Inputs of visibility MESSAGE are declared and assigned like the others (vis-message); an input without a value (not required, not given) is declared but not assigned, so it reads 0 (required-false); `#@output` names are not declared",
        "A `#@` line SciJava cannot parse (no space between type and attributes before the name, `#@ script (`, an unknown type, an indented line) is left in the source: the IJ1 interpreter then stops with `Statement cannot begin with '#'` on that line; SciJava logs `[WARNING] Ignoring invalid parameter` (attr-spacing-1, script-header-space, unknown-type, attr-spacing-7)",
        "Attributes may follow the name (`#@ Integer n (value=3)`), spaces inside the parentheses are free, unknown attributes are ignored; a bare attribute value with a space makes the whole script invalid (attr-spacing-2/3/6, attr-unknown, attr-bare-values)",
        "Names that are not valid identifiers, and names of built-in macro functions or constants (print, getTitle, PI, log), are left out of the declaration and the assignments (name-with-dash, name-with-dot, name-builtin, service-log); a duplicate name keeps one declaration and the value given (duplicate-name); the script's own `var a = 7` runs after the injection and wins (own-var-collision), a later one does not (own-var-later)",
        "Headless with no value: a required input with a default gets it (or the persisted value); a required input with neither cancels the run before it starts, reason `'<name>' is required but unset.` (required-default-missing, imageplus-none, date, vis-message-noval)",
        "Persisted values are keyed by the input name only: another script with an input of that name gets it (persist-shared-name); persist=false is not loaded (persist-false); a value given programmatically is persisted too",
        "Min/max/choices are not enforced on a value given programmatically (int-min-max, string-choices-unknown); callback and initializer functions are not called (callback, initializer)",
        "Outputs: `#@output` / `#@both` values read after the run (Integer 3 -> 3, Double 2 -> 2.0, an array -> 0.0, never assigned -> null); without any output declared, `result` holds what a top-level `return \"text\"` returned (a number return is the macro error `Macros can only return strings`) (output-*, implicit-*)",
        "runMacro() of a file with `#@` lines does not process them: the child stops with `Statement cannot begin with '#'` on line 1 and the caller continues (nested-runmacro)",
        "Dialog label: the `label` attribute, else the name with its first letter upper-cased (`fooBar` -> `FooBar`); an empty label also falls back to the name (label-description)");

    // ------------------------------------------------------------------ the dump hook, called from the macro
    static final List<String> DUMP = new ArrayList<>();

    /** call("ParamGolden.dump") from a running macro: its tokenized program, one entry per source line. */
    public static String dump() {
        try {
            Object interp = Class.forName("ij.macro.Interpreter").getMethod("getInstance").invoke(null);
            java.lang.reflect.Field pf = interp.getClass().getDeclaredField("pgm"); pf.setAccessible(true);
            Object pgm = pf.get(interp);
            int[] code = (int[]) pgm.getClass().getMethod("getCode").invoke(pgm);
            java.lang.reflect.Field lf = pgm.getClass().getDeclaredField("lineNumbers"); lf.setAccessible(true);
            int[] lines = (int[]) lf.get(pgm);
            java.lang.reflect.Field tf = pgm.getClass().getDeclaredField("table"); tf.setAccessible(true);
            Object[] table = (Object[]) tf.get(pgm);
            Class<?> mc = Class.forName("ij.macro.MacroConstants");
            int mask = mc.getField("TOK_MASK").getInt(null), shift = mc.getField("TOK_SHIFT").getInt(null);
            int NUMBER = mc.getField("NUMBER").getInt(null), STR = mc.getField("STRING_CONSTANT").getInt(null), EOF = mc.getField("EOF").getInt(null);
            java.lang.reflect.Method dec = pgm.getClass().getMethod("decodeToken", int.class);
            Map<Integer, StringBuilder> byLine = new TreeMap<>();
            for (int i = 0; i < code.length; i++) {
                int tok = code[i] & mask;
                if (tok == EOF) break;
                String s;
                if (tok == NUMBER) s = Double.toString(table[code[i] >> shift].getClass().getField("value").getDouble(table[code[i] >> shift]));
                else if (tok == STR) { StringBuilder q = new StringBuilder(); Kit.quote((String) table[code[i] >> shift].getClass().getField("str").get(table[code[i] >> shift]), q); s = q.toString(); }
                else s = (String) dec.invoke(pgm, code[i]);
                byLine.computeIfAbsent(lines[i], k -> new StringBuilder());
                StringBuilder b = byLine.get(lines[i]);
                if (b.length() > 0) b.append(' ');
                b.append(s);
            }
            DUMP.clear();
            for (Map.Entry<Integer, StringBuilder> e : byLine.entrySet()) DUMP.add(e.getKey() + ": " + e.getValue());
        } catch (Throwable t) { DUMP.clear(); DUMP.add("dump failed: " + t); }
        return "";
    }

    /** SciJava events of a run: a preprocessor that cancels the module says why only through these (public event API). */
    public static final class Events {
        final List<String> statusWarnings = new ArrayList<>();
        String canceled;
        @org.scijava.event.EventHandler
        public void onStatus(org.scijava.app.event.StatusEvent e) {
            if (e.isWarning() && e.getStatusMessage() != null && !e.getStatusMessage().isEmpty()) statusWarnings.add(e.getStatusMessage());
        }
        @org.scijava.event.EventHandler
        public void onCanceled(org.scijava.module.event.ModuleCanceledEvent e) { canceled = e.getReason() == null ? "" : e.getReason(); }
        void clear() { statusWarnings.clear(); canceled = null; }
    }
    static final Events EVENTS = new Events();

    // ------------------------------------------------------------------ driver
    static Context ctx;
    static ScriptService ss;
    static Path scripts;
    static String dirSlash;

    public static void main(String[] a) throws Exception {
        Locale.setDefault(Locale.ROOT);
        Path out = Paths.get(a[0]).toAbsolutePath();
        scripts = Paths.get(a[1]).toAbsolutePath();
        Files.createDirectories(scripts);
        Path corpus = out.resolve("params");
        Files.createDirectories(corpus);
        dirSlash = scripts.toString().replace('\\', '/') + "/";
        String only = System.getProperty("ijm.only", "");
        net.imagej.ImageJ gateway = new net.imagej.ImageJ();
        ctx = gateway.context();
        ss = ctx.service(ScriptService.class);
        PrefService prefs = ctx.service(PrefService.class);
        ctx.service(org.scijava.event.EventService.class).subscribe(EVENTS);
        Map<String, Object> cases = new LinkedHashMap<>();
        for (Case k : CASES) {
            if (!only.isEmpty() && !k.id.contains(only)) continue;
            prefs.clearAll();
            closeImages();
            Object image = null;
            Map<String, Object> imageDesc = null;
            if (k.image) {
                image = newImage(k.id);
                imageDesc = Kit.map("title", "img-" + k.id, "type", "8-bit ramp", "width", 16, "height", 8, "id", ((ij.ImagePlus) image).getID());
            }
            Files.write(corpus.resolve(k.id + ".ijm"), k.source.getBytes(StandardCharsets.UTF_8));
            for (Map.Entry<String, String> f : k.files.entrySet()) {
                Files.write(scripts.resolve(f.getKey()), f.getValue().getBytes(StandardCharsets.UTF_8));
                Files.write(corpus.resolve(k.id + "." + f.getKey()), f.getValue().getBytes(StandardCharsets.UTF_8));
            }
            Map<String, Object> e = Kit.map("source", k.source);
            if (!k.files.isEmpty()) e.put("files", new LinkedHashMap<>(k.files));
            if (k.note != null) e.put("note", k.note);
            if (imageDesc != null) e.put("image", imageDesc);
            e.put("parsed", parse(k.id, k.source));
            List<Object> runs = new ArrayList<>();
            int ri = 0;
            for (Run r : k.runs) {
                String src = r.source != null ? r.source : k.source;
                Map<String, Object> rr = execute(k.id + "-r" + ri, src, r.inputs, image);
                Map<String, Object> rec = Kit.map("inputs", jsonInputs(r.inputs));
                if (r.source != null) rec.put("source", r.source);
                if (r.note != null) rec.put("note", r.note);
                rec.putAll(rr);
                runs.add(rec);
                ri++;
            }
            e.put("runs", runs);
            // what the engine ran: the first run again, with the dump call on an extra last line
            if (!k.runs.isEmpty() && k.runs.get(0).source == null) {
                prefs.clearAll();
                String src = k.source + (k.source.endsWith("\n") ? "" : "\n") + "call(\"ParamGolden.dump\");\n";
                int dumpLine = src.split("\n", -1).length - 1;
                DUMP.clear();
                execute(k.id + "-dump", src, k.runs.get(0).inputs, image);
                List<Object> inj = new ArrayList<>();
                for (String s : DUMP) if (!s.startsWith(dumpLine + ": ")) inj.add(s);
                boolean failed = DUMP.size() == 1 && DUMP.get(0).startsWith("dump failed");
                e.put("program", DUMP.isEmpty() || failed ? null : inj);
                if (failed) e.put("programNote", "no running interpreter when the dump call ran (a nested runMacro ended it)");
                else if (DUMP.isEmpty()) e.put("programNote", "the run never reached the dump call (error, return, cancel or exit first)");
                else e.put("programNote", "the dump call sat on line " + dumpLine + " (left out)");
            }
            Kit.scrub(e, new String[][] { { dirSlash, "{DIR}" } });
            identityHashes(e);
            cases.put(k.id, e);
            System.out.println(k.id + " done");
        }
        Map<String, Object> doc = Kit.map(
            "fiji", Kit.map("imagej", "2.18.0", "imagej-legacy", "3.0.0", "scijava-common", "2.101.0", "ij", ij.IJ.getVersion().replaceFirst("^.*/", "")),
            "generator", "tools/ij_fixtures/macro/ParamGolden.java",
            "note", "headless Fiji (java.awt.headless=true); inputs given programmatically through ScriptService.run(file, true, inputs), the way "
                + "a caller passes values without a dialog (runs with {} show the headless defaults); SciJava prefs cleared before each case. "
                + "parsed.inputs[].label = ModuleItem.getLabel(), widgetLabel = what a dialog shows (DefaultWidgetModel.getWidgetLabel). "
                + "runs[].log = what print wrote (stdout), error = the Macro Error text headless Fiji prints, warnings = SciJava's log lines. "
                + "program = the tokenized program the IJ1 engine ran (see ParamGolden.dump); {DIR} = the folder of the case scripts. "
                + "Input values: Java type in javaType; File paths print with backslashes because the capture ran on Windows",
            "findings", FINDINGS,
            "cases", cases);
        Kit.writeJson(out.resolve("params-golden.json"), doc);
        System.exit(0);
    }

    /** Object.toString identity hashes (`net.imagej.ImgPlus@6d825598`) change per run: written as `@<hash>`. */
    @SuppressWarnings("unchecked")
    static Object identityHashes(Object o) {
        if (o instanceof String) return ((String) o).replaceAll("([\\w$])@[0-9a-f]{4,8}\\b", "$1@<hash>");
        if (o instanceof Map) { for (Map.Entry<String, Object> x : ((Map<String, Object>) o).entrySet()) x.setValue(identityHashes(x.getValue())); return o; }
        if (o instanceof List) { List<Object> l = (List<Object>) o; for (int i = 0; i < l.size(); i++) l.set(i, identityHashes(l.get(i))); return o; }
        return o;
    }

    static Object newImage(String id) {
        ij.ImagePlus imp = ij.IJ.createImage("img-" + id, "8-bit ramp", 16, 8, 1);
        imp.show();
        return imp;
    }

    static void closeImages() {
        int[] ids = ij.WindowManager.getIDList();
        if (ids != null) for (int id : ids) { ij.ImagePlus i = ij.WindowManager.getImage(id); if (i != null) { i.changes = false; i.close(); } }
    }

    static Map<String, Object> jsonInputs(Map<String, Object> in) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : in.entrySet()) {
            Object v = e.getValue();
            Object jv;
            if (v instanceof File) jv = ((File) v).getPath().replace('\\', '/');
            else if (v instanceof Double || v instanceof Float) jv = v;
            else if (v instanceof Number || v instanceof Boolean || v instanceof String) jv = v instanceof java.math.BigInteger || v instanceof java.math.BigDecimal || v instanceof Long ? v.toString() : v;
            else jv = String.valueOf(v);
            m.put(e.getKey(), Kit.map("value", jv, "javaType", v == IMAGE ? "ij.ImagePlus (the case image)" : v.getClass().getName()));
        }
        return m;
    }

    static Map<String, Object> parse(String id, String source) throws Exception {
        Map<String, Object> p = new LinkedHashMap<>();
        Path f = scripts.resolve(id + ".ijm");
        Files.write(f, source.getBytes(StandardCharsets.UTF_8));
        PrintStream oldErr = System.err, oldOut = System.out;
        ByteArrayOutputStream eb = new ByteArrayOutputStream();
        System.setErr(new PrintStream(eb, true, "UTF-8"));
        System.setOut(new PrintStream(eb, true, "UTF-8"));
        List<Object> ins = new ArrayList<>(), outs = new ArrayList<>();
        String error = null;
        ScriptInfo info = null;
        try {
            info = new ScriptInfo(ctx, f.toFile());
            for (ModuleItem<?> it : info.inputs()) ins.add(item(info, it, source));
            for (ModuleItem<?> it : info.outputs()) outs.add(Kit.map("name", it.getName(), "type", it.getType().getName()));
        } catch (Throwable t) { error = String.valueOf(t); }
        finally { System.setErr(oldErr); System.setOut(oldOut); }
        p.put("error", error);
        p.put("warnings", warnings(new String(eb.toByteArray(), StandardCharsets.UTF_8), true));
        p.put("inputs", ins);
        p.put("outputs", outs);
        if (info != null) p.put("script", Kit.map("name", info.getName(), "label", info.getLabel(), "menuPath", info.getMenuPath() == null ? null : info.getMenuPath().toString()));
        return p;
    }

    static Map<String, Object> item(ScriptInfo info, ModuleItem<?> it, String source) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", it.getName());
        m.put("type", it.getType().getName());
        m.put("declared", declared(source, it.getName()));
        m.put("label", it.getLabel());
        String wl;
        try { wl = new org.scijava.widget.DefaultWidgetModel(ctx, null, info.createModule(), it, new ArrayList<>()).getWidgetLabel(); }
        catch (Throwable t) { wl = null; }
        m.put("widgetLabel", wl);
        m.put("description", it.getDescription());
        m.put("style", it.getWidgetStyle());
        m.put("min", str(it.getMinimumValue()));
        m.put("max", str(it.getMaximumValue()));
        m.put("softMin", str(it.getSoftMinimum()));
        m.put("softMax", str(it.getSoftMaximum()));
        m.put("stepSize", str(it.getStepSize()));
        List<Object> ch = null;
        if (it.getChoices() != null && !it.getChoices().isEmpty()) { ch = new ArrayList<>(); for (Object o : it.getChoices()) ch.add(String.valueOf(o)); }
        m.put("choices", ch);
        m.put("columns", it.getColumnCount());
        m.put("rows", it.get("rows"));
        m.put("value", str(it.getDefaultValue()));
        m.put("persist", it.isPersisted());
        m.put("persistKey", it.getPersistKey());
        m.put("required", it.isRequired());
        m.put("visibility", String.valueOf(it.getVisibility()));
        m.put("callback", it.getCallback());
        m.put("initializer", it.getInitializer());
        m.put("autoFill", it.isAutoFill());
        m.put("ioType", String.valueOf(it.getIOType()));
        return m;
    }

    static String str(Object o) { return o == null ? null : String.valueOf(o); }

    /** The type word as written on the parameter's line (the line that ends with the name, or carries it before its attributes). */
    static String declared(String source, String name) {
        for (String line : source.split("\r?\n")) {
            String t = line.trim();
            if (!t.contains("@")) continue;
            String body = t.substring(t.indexOf('@') + 1).trim();
            body = body.replaceFirst("^(input|output|both)\\s*", "");
            String noAttrs = body.replaceAll("\\(.*?\\)(?=([^\"]*\"[^\"]*\")*[^\"]*$)", " ").trim();
            String[] w = noAttrs.split("\\s+");
            if (w.length >= 2 && w[w.length - 1].equals(name)) return w[0];
        }
        return null;
    }

    static List<Object> warnings(String err, boolean firstLinesOnly) {
        List<Object> l = new ArrayList<>();
        for (String s : err.replace("\r\n", "\n").split("\n")) {
            if (s.startsWith("[WARNING]") || s.startsWith("[ERROR]")) l.add(s);
        }
        return l;
    }

    static Map<String, Object> execute(String fileId, String src, Map<String, Object> inputs, Object image) throws Exception {
        Path f = scripts.resolve(fileId + ".ijm");
        String text = src.replace("{DIR}", dirSlash);
        Files.write(f, text.getBytes(StandardCharsets.UTF_8));
        Map<String, Object> in = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : inputs.entrySet()) in.put(e.getKey(), e.getValue() == IMAGE ? image : e.getValue());
        PrintStream oldErr = System.err;
        ByteArrayOutputStream eb = new ByteArrayOutputStream();
        System.setErr(new PrintStream(eb, true, "UTF-8"));
        final Map<String, Object>[] outputs = new Map[1];
        final Object[] ret = new Object[1];
        final String[] canceled = new String[1];
        EVENTS.clear();
        Kit.Watched w;
        try {
            w = Kit.runWatched(() -> {
                try {
                    ScriptModule m = ss.run(f.toFile(), true, in).get();
                    outputs[0] = new LinkedHashMap<>(m.getOutputs());
                    ret[0] = m.getReturnValue();
                    if (m instanceof org.scijava.Cancelable && ((org.scijava.Cancelable) m).isCanceled())
                        canceled[0] = String.valueOf(((org.scijava.Cancelable) m).getCancelReason());
                } catch (Exception ex) { throw new RuntimeException(ex); }
            }, 120000);
        } finally { System.setErr(oldErr); }
        Map<String, Object> r = new LinkedHashMap<>();
        Parsed so = parseStream(w.log);
        List<String> errLines = new ArrayList<>(Arrays.asList(new String(eb.toByteArray(), StandardCharsets.UTF_8).replace("\r\n", "\n").split("\n", -1)));
        if (!errLines.isEmpty() && errLines.get(errLines.size() - 1).isEmpty()) errLines.remove(errLines.size() - 1);
        Parsed se = parseStream(errLines);
        List<Object> log = so.log;
        Map<String, Object> error = so.error != null ? so.error : se.error;
        r.put("log", log);
        Map<String, Object> outs = null;
        if (outputs[0] != null) { outs = new LinkedHashMap<>(); for (Map.Entry<String, Object> e : outputs[0].entrySet()) outs.put(e.getKey(), describe(e.getValue())); }
        r.put("outputs", outs);
        r.put("returnValue", ret[0] == null ? null : describe(ret[0]));
        r.put("error", error);
        Thread.sleep(50);
        if (canceled[0] == null && EVENTS.canceled != null) canceled[0] = EVENTS.canceled;
        if (canceled[0] != null) r.put("canceled", canceled[0]);
        if (!EVENTS.statusWarnings.isEmpty()) r.put("statusWarnings", new ArrayList<Object>(EVENTS.statusWarnings));
        if (w.thrown != null) {
            Throwable t = w.thrown; while (t.getCause() != null) t = t.getCause();
            r.put("thrown", t.getClass().getName() + (t.getMessage() == null ? "" : ": " + t.getMessage()));
        }
        List<Object> warn = new ArrayList<>(so.warnings);
        warn.addAll(se.warnings);
        if (!warn.isEmpty()) r.put("warnings", warn);
        if (!se.log.isEmpty()) r.put("stderr", se.log);
        return r;
    }

    static final class Parsed { final List<Object> log = new ArrayList<>(), warnings = new ArrayList<>(); Map<String, Object> error; }

    /**
     * Splits a captured stream: "Macro Error: <message> in line <n>" blocks (headless Fiji prints the error dialog's text, on stderr),
     * SciJava log lines ([WARNING] / [ERROR], their stack traces dropped), and everything else (the Log on stdout).
     */
    static Parsed parseStream(List<String> lines) {
        Parsed p = new Parsed();
        boolean inTrace = false;
        for (int i = 0; i < lines.size(); i++) {
            String s = lines.get(i);
            if (s.matches("^\\[(WARNING|ERROR|INFO|DEBUG)\\].*")) { if (!s.startsWith("[INFO]") && !s.startsWith("[DEBUG]")) p.warnings.add(s); inTrace = true; continue; }
            if (inTrace && (s.startsWith("\tat ") || s.startsWith("Caused by:") || s.matches("^\\s+\\.\\.\\. \\d+ more$")
                    || s.matches("^[a-z][\\w$]*(\\.[\\w$]+)+(Exception|Error)(: .*)?$"))) continue;
            inTrace = false;
            if (s.startsWith("Macro Error: ")) {
                String first = s.substring(13);
                int k = first.lastIndexOf(" in line ");
                Map<String, Object> error = Kit.map("message", k < 0 ? first : first.substring(0, k), "line", k < 0 ? 0 : Integer.parseInt(first.substring(k + 9).trim()));
                StringBuilder rest = new StringBuilder(s);
                int j = i + 1;
                while (j < lines.size() && j <= i + 8) { rest.append('\n').append(lines.get(j)); if (!lines.get(j).startsWith("\t") && !lines.get(j).equals(" ")) break; j++; }
                error.put("excerpt", j < lines.size() ? lines.get(j) : "");
                error.put("text", rest.toString());
                if (p.error == null) p.error = error;
                i = j;
                continue;
            }
            p.log.add(s);
        }
        return p;
    }

    static Object describe(Object v) {
        if (v == null) return null;
        return Kit.map("toString", String.valueOf(v), "javaType", v.getClass().getName());
    }
}
