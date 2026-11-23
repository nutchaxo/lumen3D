open("{ROOT}rgb.png");
print("title " + getTitle() + " " + getWidth() + "x" + getHeight() + " bitDepth " + bitDepth());
v = getPixel(15, 0);
print("pixel " + ((v >> 16) & 255) + " " + ((v >> 8) & 255) + " " + (v & 255));
