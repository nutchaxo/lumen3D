newImage("hs", "16-bit ramp", 16, 16, 12);
run("Stack to Hyperstack...", "order=xyczt(default) channels=2 slices=3 frames=2 display=Color");
saveAs("Tiff", "{ROOT}hs.tif");
open("{ROOT}hs.tif");
getDimensions(w, h, c, z, t);
print("dimensions " + w + " " + h + " " + c + " " + z + " " + t);
