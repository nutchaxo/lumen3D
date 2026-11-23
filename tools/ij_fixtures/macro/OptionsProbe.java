// Local only (never shipped, never CI). Goldens of ImageJ 1.54p's macro option-string semantics, from the REAL jar, for
// js/modules/studio/advanced-studio/ij-macro-cmds.js (IJMacroOptions) — read by tests/js/test_ij_macro_options.mjs.
//   javac -cp ij-1.54p.jar -d <tmp> tools/ij_fixtures/macro/OptionsProbe.java
//   java -Duser.home=<tmp>/home -cp "<tmp>;ij-1.54p.jar" OptionsProbe tests/fixtures/ij-macro/options-golden.json
// Needs a desktop session (GenericDialog is an AWT Dialog; none is shown: the macro-mode dialogs return at showDialog()).
// An invalid number makes GenericDialog call IJ.error: the probe redirects it to the log and records the text with the value.
import ij.Macro;
import ij.gui.GenericDialog;
import ij.plugin.frame.Recorder;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class OptionsProbe {
	static StringBuilder out = new StringBuilder();
	static boolean first;

	static String q(String s) {
		if (s == null) return "null";
		StringBuilder b = new StringBuilder("\"");
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			if (c == '"' || c == '\\') b.append('\\').append(c);
			else if (c < 32 || c > 126) b.append(String.format("\\u%04x", (int) c));
			else b.append(c);
		}
		return b.append('"').toString();
	}
	static String num(double d) {
		if (Double.isNaN(d)) return "\"NaN\"";
		if (Double.isInfinite(d)) return d > 0 ? "\"Infinity\"" : "\"-Infinity\"";
		return Double.toString(d).replace("E", "e");
	}
	static void begin(String name) { out.append(first ? "" : ",\n").append(' ').append(q(name)).append(": [\n"); first = false; rowFirst = true; }
	static boolean rowFirst;
	static void row(String json) { out.append(rowFirst ? "  " : ",\n  ").append(json); rowFirst = false; }
	static void end() { out.append("\n ]"); }

	public static void main(String[] args) throws Exception {
		String file = args.length > 0 ? args[0] : "options-golden.json";
		out.append("{\n \"imagej\": ").append(q(ij.IJ.getVersion())).append(",\n \"generator\": \"tools/ij_fixtures/macro/OptionsProbe.java\",\n");
		first = true;

		begin("trimKey");
		for (String s : new String[] { "Sigma (Radius):", "Radius", "Width (pixels):", "Pixel_width:", "16-bit range:", "Feret's diameter", " Preview", "C1 (red):",
				"fast (less accurate)", "Do_not create substack", "X:Y", "ÉLAN Value", "Histogram_start", "a:b c", "", "UPPER", "tM1 / tM2 denominator", "Threshold, channel 1" })
			row("[" + q(s) + ", " + q(Macro.trimKey(s)) + "]");
		end();

		// GenericDialog.saveLabel over one dialog: a fresh dialog per label list, the keys read back from its private table
		begin("keyOf");
		String[][] lists = { { "Radius", "Radius", "Radius" }, { "Prune cycle method:", "Prune ends" }, { "Channels (c):", "Slices (z):", "Frames (t):" },
				{ "Width:", "Height:", "Width (pixels):" }, { "X", "x", "X:" }, { "", "", "Name:" }, { "a_0", "a", "a" }, { " Use overlay", " Use_text tool font" },
				{ "Image1:", "Image2:", "Image1:" } };
		Method save = GenericDialog.class.getDeclaredMethod("saveLabel", Object.class, String.class);
		save.setAccessible(true);
		Field labels = GenericDialog.class.getDeclaredField("labels");
		labels.setAccessible(true);
		for (String[] l : lists) {
			GenericDialog gd = new GenericDialog("probe");
			Object[] comps = new Object[l.length];
			for (int i = 0; i < l.length; i++) { comps[i] = new Object(); save.invoke(gd, comps[i], l[i]); }
			Hashtable t = (Hashtable) labels.get(gd);
			StringBuilder a = new StringBuilder("["), k = new StringBuilder("[");
			for (int i = 0; i < l.length; i++) { a.append(i > 0 ? ", " : "").append(q(l[i])); k.append(i > 0 ? ", " : "").append(q((String) t.get(comps[i]))); }
			row("[" + a + "], " + k + "]]");
			gd.dispose();
		}
		end();

		begin("getValue");
		String[][] gv = { { "sigma=2", "sigma" }, { "sigma=2 ", "Sigma (Radius):" }, { "Sigma=2", "sigma" }, { "dsigma=3 sigma=4", "sigma" }, { "xsigma=3", "sigma" },
				{ "_sigma=3", "sigma" }, { "1sigma=3", "sigma" }, { "title=[a b c] x=1", "title" }, { "title=[a [b] c] x=1", "title" }, { "title=[unclosed x=1", "title" },
				{ "title='quoted text' x=1", "title" }, { "title='unclosed", "title" }, { "title= x=1", "title" }, { "title=", "title" }, { "a=1 b=2 c=3", "c" },
				{ "c1=[my image.tif] c2=*None*", "c2" }, { "value=&v", "value" }, { "radius=2 radius=3", "radius" }, { "é=1 rayon=2", "rayon" }, { "érayon=2", "rayon" },
				{ "key=value", "missing" }, { "text1=[1 2 3\\n4 5 6] normalize", "text1" }, { "x=[]", "x" }, { "stack", "stack" }, { "w=1\ty=2", "y" } };
		for (String[] v : gv) row("[" + q(v[0]) + ", " + q(v[1]) + ", " + q(Macro.getValue(v[0], v[1], "<default>")) + "]");
		end();

		begin("isMatch");
		GenericDialog gm = new GenericDialog("probe");
		Method im = GenericDialog.class.getDeclaredMethod("isMatch", String.class, String.class);
		im.setAccessible(true);
		String[][] mv = { { "stack ", "stack " }, { "sigma=2 stack ", "stack " }, { "title=[my stack] ", "stack " }, { "title=[a] stack ", "stack " },
				{ "title=stack ", "stack " }, { "x= stack ", "stack " }, { "xstack ", "stack " }, { "stacks ", "stack " }, { "a stack b ", "stack " },
				{ "title=[x] y=[stack z] ", "stack " }, { "light ", "light " }, { "create light background ", "light " }, { "dark light ", "dark " },
				{ "a=1 b ", "b " }, { "a=1  b ", "b " }, { "=x b ", "b " }, { " b ", "b " }, { "title=[[nested] stack] ", "stack " } };
		for (String[] v : mv) row("[" + q(v[0]) + ", " + q(v[1]) + ", " + im.invoke(gm, v[0], v[1]) + "]");
		gm.dispose();
		end();

		// Macro.setOptions then getOptions on a "Run$_" thread (what IJ.run does before a command)
		begin("normalize");
		String prev = Thread.currentThread().getName();
		Thread.currentThread().setName("Run$_probe");
		for (String s : new String[] { null, "", "sigma=2", "sigma=2 ", " ", "stack" }) {
			Macro.setOptions(s);
			row("[" + q(s) + ", " + q(Macro.getOptions()) + "]");
		}
		Macro.setOptions(null);
		end();

		// GenericDialog in macro mode: a dialog built on a Run$_ thread after Macro.setOptions, read with getNext* (never shown)
		begin("macroDialog");
		Object[][] dv = {
			{ "sigma=2.5", "N", "Sigma (Radius):", 2.0, 2 },
			{ "sigma=0x1F", "N", "Sigma (Radius):", 2.0, 2 },
			{ "sigma=0X1F", "N", "Sigma (Radius):", 2.0, 2 },
			{ "sigma=abc", "N", "Sigma (Radius):", 2.0, 2 },
			{ "sigma=&abc", "N", "Sigma (Radius):", 2.0, 2 },
			{ "sigma=1e2", "N", "Sigma (Radius):", 2.0, 2 },
			{ "sigma=4d", "N", "Sigma (Radius):", 2.0, 2 },
			{ "sigma=[ 3 ]", "N", "Sigma (Radius):", 2.0, 2 },
			{ "sigma=-.5", "N", "Sigma (Radius):", 2.0, 2 },
			{ "sigma=+7", "N", "Sigma (Radius):", 2.0, 2 },
			{ "sigma=NaN", "N", "Sigma (Radius):", 2.0, 2 },
			{ "sigma=Infinity", "N", "Sigma (Radius):", 2.0, 2 },
			{ "sigma=0x", "N", "Sigma (Radius):", 2.0, 2 },
			{ "sigma=0xZZ", "N", "Sigma (Radius):", 2.0, 2 },
			{ "other=1", "N", "Sigma (Radius):", 2.0, 2 },
			{ "light", "B", "Light background", false, 0 },
			{ "x=1", "B", "Light background", true, 0 },
			{ "title=[light] x=1", "B", "Light background", true, 0 },
			{ "method=Huang", "C", "Method:", "Default", 0 },
			{ "method=[Try all]", "C", "Method:", "Default", 0 },
			{ "method=huang", "C", "Method:", "Default", 0 },
			{ "x=1", "C", "Method:", "Default", 0 },
			{ "title=[my image]", "S", "Title:", "untitled", 0 },
			{ "title=", "S", "Title:", "untitled", 0 },
			{ "x=1", "S", "Title:", "untitled", 0 },
			{ "range=5-9", "S", "Range:", "1-10", 0 },
			{ "which=Dark", "R", "Which:", "Bright", 0 },
			{ "text1=[1 2\\n3 4]", "T", "", "0 0", 0 },
		};
		for (Object[] v : dv) {
			String opts = (String) v[0];
			Macro.setOptions(opts);
			GenericDialog gd = new GenericDialog("Probe");
			String kind = (String) v[1], label = (String) v[2];
			String result;
			// an invalid number: IJ.error goes to the log instead of a modal box, and the message is recorded with the NaN
			ij.IJ.redirectErrorMessages(true);
			try {
			switch (kind) {
				case "N": gd.addNumericField(label, (Double) v[3], (Integer) v[4]); gd.showDialog(); result = num(gd.getNextNumber()); break;
				case "B": gd.addCheckbox(label, (Boolean) v[3]); gd.showDialog(); result = Boolean.toString(gd.getNextBoolean()); break;
				case "C": gd.addChoice(label, new String[] { "Default", "Huang", "Try all" }, (String) v[3]); gd.showDialog(); result = q(gd.getNextChoice()); break;
				case "S": gd.addStringField(label, (String) v[3]); gd.showDialog(); result = q(gd.getNextString()); break;
				case "R": gd.addRadioButtonGroup(label, new String[] { "Bright", "Dark" }, 1, 2, (String) v[3]); gd.showDialog(); result = q(gd.getNextRadioButton()); break;
				default: gd.addTextAreas((String) v[3], null, 3, 10); gd.showDialog(); result = q(gd.getNextText()); break;
			}
			} catch (RuntimeException e) {
				result = "{\"aborted\": " + q(e.getMessage()) + "}";
			}
			String err = ij.IJ.getErrorMessage();
			ij.IJ.redirectErrorMessages(false);
			if (err != null) result = "{\"value\": " + result + ", \"error\": " + q(err) + "}";
			row("[" + q(opts) + ", " + q(kind) + ", " + q(label) + ", " + (v[3] instanceof String ? q((String) v[3]) : v[3] instanceof Double ? num((Double) v[3]) : v[3].toString()) + ", " + result + "]");
			gd.dispose();
		}
		Macro.setOptions(null);
		Thread.currentThread().setName(prev);
		end();

		begin("javaDouble");
		for (String s : new String[] { "2", "2.5", " 3 ", "1e5", "1E-3", "1.", ".5", ".", "1e", "4d", "4f", "4F", "+7", "-0", "NaN", "-Infinity", "Infinity", "inf", "0x10",
				"0x1p3", "0x1.8p1", "1_000", "1,5", "", "  ", "1 2", "\t9\n", "1e400", "-1e-400" }) {
			String r;
			try { r = num(Double.valueOf(s)); } catch (NumberFormatException e) { r = "null"; }
			row("[" + q(s) + ", " + r + "]");
		}
		end();

		begin("javaToString");
		for (double d : new double[] { 0, -0.0, 1, -1, 5, 2.5, 0.1, 0.001, 0.0009999, 1e-3, 9999999, 1e7, 1.5e7, 123456789.125, 1e-5, 3.14159, 1.0 / 3, 2e21, 1e100,
				Double.MIN_VALUE, Double.MAX_VALUE, 100, 1234567.5, 0.30000000000000004 })
			row("[" + num(d) + ", " + q(Double.toString(d)) + "]");
		end();

		begin("parseHex");
		for (String s : new String[] { "1F", "ff", "-10", "+10", "7fffffff", "80000000", "", "xyz", "0" }) {
			int r;
			try { r = Integer.parseInt(s, 16); } catch (NumberFormatException e) { r = 0; }
			row("[" + q(s) + ", " + r + "]");
		}
		end();

		begin("fixString");
		for (String s : new String[] { "plain", "a\\b", "say \"hi\"", "line1\nline2", "tab\there", "é", "\u0085", " " })
			row("[" + q(s) + ", " + q(Recorder.fixString(s)) + "]");
		end();

		out.append("\n}\n");
		try (Writer w = new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8)) { w.write(out.toString()); }
		System.out.println("wrote " + file);
		System.exit(0);
	}
}
