newImage("img", "8-bit ramp", 32, 32, 1);
makeRectangle(2, 3, 5, 6);
saveAs("Selection", "{ROOT}s.roi");
makeOval(1, 1, 8, 6);
saveAs("Selection", "{ROOT}o.roi");
makeLine(1, 2, 20, 25);
saveAs("Selection", "{ROOT}l.roi");
print("title " + getTitle());
