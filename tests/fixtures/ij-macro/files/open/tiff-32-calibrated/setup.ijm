setBatchMode(true);
newImage("c", "32-bit ramp", 16, 16, 1);
setVoxelSize(0.5, 0.25, 2, "um");
saveAs("Tiff", "{ROOT}cal32.tif");
