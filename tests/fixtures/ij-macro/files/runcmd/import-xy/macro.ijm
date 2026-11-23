newImage("img", "8-bit ramp", 32, 32, 1);
run("XY Coordinates... ", "open=[{ROOT}xy.txt]");
print("selectionType " + selectionType());
getSelectionBounds(x, y, w, h);
print("bounds " + x + " " + y + " " + w + " " + h);
getSelectionCoordinates(xs, ys);
print("points " + xs.length + " " + xs[0] + "," + ys[0] + " " + xs[2] + "," + ys[2]);
