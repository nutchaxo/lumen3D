open("{ROOT}stack.tif", 2);
print("title " + getTitle());
print("slices " + nSlices + " size " + getWidth() + "x" + getHeight());
print("pixel " + getPixel(0, 0));
open("{ROOT}stack.tif", 3);
print("slices " + nSlices + " pixel " + getPixel(0, 0));
