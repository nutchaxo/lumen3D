open("{ROOT}a.tif");
run("Invert");
run("Save");
print("title " + getTitle());
open("{ROOT}a.tif");
print("pixel " + getPixel(0, 0));
