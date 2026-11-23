newImage("img", "16-bit ramp", 16, 16, 1);
setVoxelSize(0.5, 0.25, 2, "um");
saveAs("Tiff", "{ROOT}cal.tiff");
print("title " + getTitle());
open("{ROOT}cal.tiff");
getVoxelSize(w, h, d, u);
print("voxel " + w + " " + h + " " + d + " " + u);
