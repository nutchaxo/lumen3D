open("{ROOT}r.roi");
print("images " + nImages);
print("title " + getTitle() + " " + getWidth() + "x" + getHeight() + " bitDepth " + bitDepth());
print("selectionType " + selectionType());
getSelectionBounds(x, y, w, h);
print("bounds " + x + " " + y + " " + w + " " + h);
