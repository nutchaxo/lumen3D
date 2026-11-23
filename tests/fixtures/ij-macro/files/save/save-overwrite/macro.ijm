open("{ROOT}a.tif");
setPixel(0, 0, 200);
run("Save");
print("title " + getTitle());
close();
open("{ROOT}a.tif");
print("reopened pixel " + getPixel(0, 0));
