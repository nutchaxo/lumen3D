newImage("img", "8-bit ramp", 32, 32, 1);
open("{ROOT}r.roi");
print("selectionType " + selectionType());
getSelectionBounds(x, y, w, h);
print("bounds " + x + " " + y + " " + w + " " + h);
print("title " + getTitle() + " " + getWidth() + "x" + getHeight());
print("images " + nImages);
