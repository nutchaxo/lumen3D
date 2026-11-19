import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.scijava.Context;
import org.scijava.command.CommandInfo;
import org.scijava.command.CommandService;
import org.scijava.module.ModuleItem;

/** Records the ModuleInfo inputs of SciJava commands (Frangi Vesselness). Usage: run_fiji.sh ModuleInfoCapture <out.json>. */
public class ModuleInfoCapture {
    /** The "Frangi Vesselness" entry of fiji-dialogs.json `commands` (used by DialogCapture, which writes the merged document). */
    static String frangiEntry() {
        Context ctx = new Context(CommandService.class);
        CommandService cs = ctx.getService(CommandService.class);
        for (CommandInfo ci : cs.getCommands()) {
            if (!String.valueOf(ci.getMenuPath()).toLowerCase().contains("frangi")) continue;
            StringBuilder path = new StringBuilder();
            java.util.List<org.scijava.MenuEntry> es = ci.getMenuPath();
            for (int i = 0; i < es.size() - 1; i++) { if (i > 0) path.append('>'); path.append(es.get(i).getName()); }
            return "{\"kind\":\"scijava\",\"menuPath\":" + DialogCapture.q(path.toString()) + ",\"frangi\":" + describe(ci) + "}";
        }
        return "{\"error\":\"Frangi Vesselness not found\"}";
    }

    public static void main(String[] a) throws Exception {
        Locale.setDefault(Locale.ROOT);
        Context ctx = new Context(CommandService.class);
        CommandService cs = ctx.getService(CommandService.class);
        List<String> found = new ArrayList<>();
        for (CommandInfo ci : cs.getCommands()) {
            String mp = String.valueOf(ci.getMenuPath());
            if (!mp.toLowerCase().contains("frangi")) continue;
            String s = describe(ci);
            found.add(s);
        }
        Files.write(Paths.get(a[0]), ("{\"commands\":[" + String.join(",", found) + "]}\n").getBytes(StandardCharsets.UTF_8));
        System.out.println("found " + found.size());
        System.exit(0);
    }

    static String describe(CommandInfo ci) {
        String mp = String.valueOf(ci.getMenuPath());
            StringBuilder s = new StringBuilder("{\"class\":" + DialogCapture.q(ci.getDelegateClassName()) + ",\"menuPath\":" + DialogCapture.q(mp) + ",\"title\":" + DialogCapture.q(ci.getTitle()) + ",\"inputs\":[");
            boolean first = true;
            for (ModuleItem<?> it : ci.inputs()) {
                if (!first) s.append(','); first = false;
                Object dv = null; try { dv = it.getDefaultValue(); } catch (Throwable t) { }
                s.append("{\"name\":").append(DialogCapture.q(it.getName()))
                 .append(",\"label\":").append(DialogCapture.q(it.getLabel()))
                 .append(",\"type\":").append(DialogCapture.q(it.getType().getName()))
                 .append(",\"default\":").append(DialogCapture.q(dv == null ? null : String.valueOf(dv)))
                 .append(",\"description\":").append(DialogCapture.q(it.getDescription()))
                 .append(",\"visibility\":").append(DialogCapture.q(String.valueOf(it.getVisibility())))
                 .append(",\"required\":").append(it.isRequired()).append('}');
            }
            s.append("],\"outputs\":[");
            first = true;
            for (ModuleItem<?> it : ci.outputs()) {
                if (!first) s.append(','); first = false;
                s.append("{\"name\":").append(DialogCapture.q(it.getName())).append(",\"type\":").append(DialogCapture.q(it.getType().getName())).append('}');
            }
            s.append("]}");
        return s.toString();
    }
}
