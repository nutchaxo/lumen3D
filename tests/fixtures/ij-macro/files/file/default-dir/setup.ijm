setBatchMode(true);
File.makeDirectory("{ROOT}sub");
newImage("a", "8-bit ramp", 16, 16, 1);
saveAs("Tiff", "{ROOT}sub/a.tif");
