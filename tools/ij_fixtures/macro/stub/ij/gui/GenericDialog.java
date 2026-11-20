package ij.gui;

/**
 * Headless stand-in for ij.gui.GenericDialog, placed in front of the jar on the class path of the
 * isolated class loader (MacroGolden). The only caller that matters is Interpreter.showError, which
 * builds the dialog "<message> in line <n>\n <source line> \n" and would throw a HeadlessException:
 * the stub prints that message (MacroProbe tags it "errorDialog" from the stack) and shows nothing.
 * It exists so that an error inside a nested macro (eval) is observable too.
 */
public class GenericDialog {
    public GenericDialog(String title) { }
    public void setInsets(int top, int left, int bottom) { }
    public void addMessage(String text) { System.out.println(text); }
    public void addCheckbox(String label, boolean state) { }
    public void hideCancelButton() { }
    public void showDialog() { }
    public boolean getNextBoolean() { return false; }
    public boolean wasCanceled() { return false; }
}
