setBatchMode(true);
newImage("a", "8-bit ramp", 8, 8, 1);
saveAs("Tiff", "{ROOT}x.tiff");
File.makeDirectory("{ROOT}sub");
saveAs("Tiff", "{ROOT}sub/y.tif");
File.rename("{ROOT}sub/y.tif", "{ROOT}sub/y.longext");
saveAs("Tiff", "{ROOT}sub/z.tif");
File.rename("{ROOT}sub/z.tif", "{ROOT}sub/z.abc");
