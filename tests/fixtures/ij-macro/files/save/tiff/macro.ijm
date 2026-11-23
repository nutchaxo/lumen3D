newImage("img", "8-bit ramp", 16, 16, 1);
saveAs("Tiff", "{ROOT}o.tif");
print("title " + getTitle());
open("{ROOT}o.tif");
print("reopened " + getTitle() + " " + getPixel(15, 0));
