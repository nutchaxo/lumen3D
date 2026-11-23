newImage("img", "8-bit ramp", 16, 16, 1);
run("Tiff...", "path=[{ROOT}t.tif]");
setPixel(0, 0, 99);
run("Tiff...", "path=[{ROOT}t.tif]");
print("exists " + File.exists("{ROOT}t.tif"));
open("{ROOT}t.tif");
print("pixel " + getPixel(0, 0));
