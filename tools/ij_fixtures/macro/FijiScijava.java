import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.scijava.Context;
import org.scijava.command.CommandInfo;
import org.scijava.command.CommandService;
import org.scijava.module.ModuleItem;

/**
 * SciJava commands of the Studio's Fiji list (Frangi Vesselness): no GenericDialog to open, the macro keys are the @Parameter names of the
 * command's ModuleInfo (the public SciJava API). The entry is merged, as text, into the `commands` object DialogKeys just wrote.
 * Usage: FijiScijava <fiji-macro-keys.json>. Local only.
 */
public class FijiScijava {
    public static void main(String[] a) throws Exception {
        Locale.setDefault(Locale.ROOT);
        Context ctx = new Context(CommandService.class);
        CommandService cs = ctx.getService(CommandService.class);
        String entry = null;
        for (CommandInfo ci : cs.getCommands()) {
            List<org.scijava.MenuEntry> es = ci.getMenuPath();
            if (es == null || es.isEmpty() || !es.get(es.size() - 1).getName().equals("Frangi Vesselness")) continue;
            StringBuilder path = new StringBuilder();
            for (int i = 0; i < es.size() - 1; i++) { if (i > 0) path.append('>'); path.append(es.get(i).getName()); }
            List<Object> comps = new ArrayList<>();
            for (ModuleItem<?> it : ci.inputs()) {
                Object dv = null; try { dv = it.getDefaultValue(); } catch (Throwable t) { /* no default */ }
                Class<?> ty = it.getType();
                String label = it.getLabel() != null ? it.getLabel() : it.getName();
                Map<String, Object> c;
                if (ty == boolean.class || ty == Boolean.class) c = DialogKeys.map("t", "checkbox", "label", label, "key", it.getName(), "state", Boolean.TRUE.equals(dv));
                else if (Number.class.isAssignableFrom(ty) || (ty.isPrimitive() && ty != char.class)) c = DialogKeys.map("t", "numeric", "label", label, "key", it.getName(), "value", dv == null ? "" : String.valueOf(dv), "decimals", DialogKeys.decimals(String.valueOf(dv)));
                else if (ty == String.class) c = DialogKeys.map("t", "string", "label", label, "key", it.getName(), "value", dv == null ? "" : String.valueOf(dv));
                else c = DialogKeys.map("t", "other", "label", label, "key", it.getName(), "type", ty.getName(), "value", dv == null ? null : String.valueOf(dv));
                c.put("visibility", String.valueOf(it.getVisibility()));
                c.put("required", it.isRequired());
                if (it.getChoices() != null && !it.getChoices().isEmpty()) {
                    List<String> items = new ArrayList<>(); for (Object o : it.getChoices()) items.add(String.valueOf(o));
                    c.put("t", "choice"); c.put("items", items); c.put("selected", dv == null ? null : String.valueOf(dv));
                }
                comps.add(c);
            }
            List<String> outs = new ArrayList<>();
            for (ModuleItem<?> it : ci.outputs()) outs.add(it.getName() + ":" + it.getType().getName());
            Map<String, Object> d = DialogKeys.map("kind", "other", "title", ci.getTitle(), "smartRecording", false, "components", comps, "processStack", false, "recorded", null);
            Map<String, Object> e = DialogKeys.map("class", ci.getDelegateClassName(), "menuPath", path.toString(), "scijava", true, "input", DialogKeys.inputDescOf(DialogKeys.INPUTS[0]),
                    "dialogs", new ArrayList<>(List.of(d)), "outputs", outs);
            StringBuilder b = new StringBuilder();
            DialogKeys.json(DialogKeys.map("Frangi Vesselness", e), b, 2);
            String s = b.toString();
            entry = s.substring(s.indexOf('{') + 1, s.lastIndexOf('}')).trim();
            break;
        }
        Path p = Paths.get(a[0]);
        String doc = new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
        if (entry == null) {
            doc = doc.replace("\"unrecognized\": []", "\"unrecognized\": [\"Frangi Vesselness\"]");
            System.out.println("Frangi Vesselness: not found as a SciJava command");
        } else {
            int k = doc.indexOf("\"commands\": {");
            if (k < 0) throw new IllegalStateException("no commands object");
            int ins = k + "\"commands\": {".length();
            doc = doc.substring(0, ins) + "\n    " + entry + "," + doc.substring(ins);
            doc = doc.replace("\"unrecognized\": [\"Frangi Vesselness\"]", "\"unrecognized\": []");
        }
        Files.write(p, doc.getBytes(StandardCharsets.UTF_8));
        System.out.println("scijava merged");
        System.exit(0);
    }
}
