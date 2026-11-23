setBatchMode(true);
newImage("hs", "16-bit ramp", 16, 16, 12);
for (i = 1; i <= 12; i++) { setSlice(i); run("Add...", "value=" + (i * 100) + " slice"); }
run("Stack to Hyperstack...", "order=xyczt(default) channels=2 slices=3 frames=2 display=Color");
saveAs("Tiff", "{ROOT}hs.tif");
