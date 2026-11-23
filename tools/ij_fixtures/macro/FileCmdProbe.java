// Local only (never shipped, never CI). Probe of the option keys ImageJ 1.54p's file commands read when a macro runs them with
// run("<command>", "<options>"), for the class F entries of js/modules/studio/advanced-studio/ij-macro-cmds.js (DOCS/studio-advanced/
// macros/FILES.md §9): each command is run on the REAL jar with only one candidate key in its options and the probe records whether the
// file was written / read. The keys and the empty-value rules found here are pinned in tests/js/test_ij_macro_files_cmdtab.mjs.
//   tools/ij_fixtures/macro/run_filecmd.sh <path/to/ij-1.54p.jar>
// Needs a desktop session (IJ.run builds the menus). One batch-mode macro in a temporary folder prints "P|<case>|<value>" lines; a key a
// command does not read would make it show its file dialog (the probe then stalls): every case listed here completes on 1.54p.
import ij.IJ;
import ij.macro.Interpreter;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class FileCmdProbe {
	public static void main(String[] args) throws Exception {
		Locale.setDefault(Locale.ROOT);
		Path dir = Files.createTempDirectory("ijfilecmd");
		String D = dir.toAbsolutePath().toString().replace('\\', '/') + "/";
		Files.write(dir.resolve("m.ijm"), "print(\"P|run|ran \"+getArgument());".getBytes(StandardCharsets.UTF_8));
		String code = String.join("\n",
			"D = \"" + D + "\";",
			"setBatchMode(true);",
			"function ex(c, p) { print(\"P|\" + c + \"|\" + File.exists(D + p)); }",
			"newImage(\"img\", \"8-bit ramp\", 16, 8, 1);",
			// save dialogs: SaveDialog.isMacro reads Macro.getValue(options, title) then "path"
			"run(\"Tiff...\", \"save=\" + D + \"t1.tif\"); ex(\"tiff.save\", \"t1.tif\");",
			"run(\"Tiff...\", \"path=\" + D + \"t2.tif\"); ex(\"tiff.path\", \"t2.tif\");",
			"run(\"Tiff...\", \"save=[\" + D + \"a b.tif]\"); ex(\"tiff.brackets\", \"a b.tif\");",
			"run(\"Jpeg...\", \"save=\" + D + \"j.jpg\"); ex(\"jpeg.save\", \"j.jpg\");",
			"run(\"PNG...\", \"save=\" + D + \"p.png\"); ex(\"png.save\", \"p.png\");",
			"run(\"Text Image...\", \"save=\" + D + \"ti.txt\"); ex(\"textImage.save\", \"ti.txt\");",
			"run(\"ZIP...\", \"save=\" + D + \"z.zip\"); ex(\"zip.save\", \"z.zip\");",
			"run(\"Raw Data...\", \"save=\" + D + \"r.raw\"); ex(\"raw.save\", \"r.raw\");",
			"run(\"LUT...\", \"save=\" + D + \"l.lut\"); ex(\"lut.save\", \"l.lut\");",
			"makeRectangle(1, 1, 4, 3);",
			"run(\"Selection...\", \"save=\" + D + \"s.roi\"); ex(\"selection.save\", \"s.roi\");",
			"run(\"XY Coordinates...\", \"save=\" + D + \"xy.txt\"); ex(\"xy.save\", \"xy.txt\");",
			"run(\"Measure\");",
			"run(\"Results...\", \"save=\" + D + \"res.csv\"); ex(\"results.save\", \"res.csv\");",
			"run(\"Select None\");",
			"run(\"Save XY Coordinates...\", \"background=0 suppress save=\" + D + \"sxy.txt\"); ex(\"saveXY.save\", \"sxy.txt\");",
			"newImage(\"untitled\", \"8-bit black\", 4, 4, 1);",
			"run(\"Save\", \"save=\" + D + \"sv.tif\"); ex(\"save.save\", \"sv.tif\"); print(\"P|save.title|\" + getTitle());",
			// open dialogs: OpenDialog(title, path) reads Macro.getValue(options, title), then "path" when null or empty
			"run(\"Open...\", \"open=\" + D + \"t1.tif\"); print(\"P|open.open|\" + getTitle());",
			"run(\"Open...\", \"path=\" + D + \"t2.tif\"); print(\"P|open.path|\" + getTitle());",
			"run(\"Open...\", \"open=[] path=[\" + D + \"a b.tif]\"); print(\"P|open.emptyOpen|\" + getTitle());",
			"run(\"Text Image... \", \"open=\" + D + \"ti.txt\"); print(\"P|textImage.open|\" + getTitle() + \" \" + bitDepth());",
			"run(\"LUT... \", \"open=\" + D + \"l.lut\"); print(\"P|lut.open|\" + getTitle());",
			"run(\"Clear Results\");",
			"run(\"Results... \", \"open=\" + D + \"res.csv\"); print(\"P|results.open|\" + nResults);",
			"run(\"Run...\", \"run=\" + D + \"m.ijm\");",
			"run(\"Run...\", \"path=\" + D + \"m.ijm\");"
		);
		Thread t = new Thread(() -> {
			try { new Interpreter().run(code); } catch (Throwable e) { System.out.println("P|thrown|" + e); e.printStackTrace(System.out); }
		}, "Run$_FileCmdProbe_Macro$");
		t.setDaemon(true);
		t.start();
		t.join(60000);
		try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) { for (Path p : ds) Files.deleteIfExists(p); }
		Files.deleteIfExists(dir);
		System.out.flush();
		System.exit(0);
	}
}
