setBatchMode(true);
newImage("stack", "8-bit black", 16, 16, 3);
for (i = 1; i <= 3; i++) { setSlice(i); run("Add...", "value=" + (i * 40) + " slice"); }
saveAs("Tiff", "{ROOT}stack.tif");
