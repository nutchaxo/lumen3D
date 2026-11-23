setBatchMode(true);
newImage("a", "8-bit ramp", 16, 16, 1);
makeRectangle(2, 3, 5, 6);
roiManager("Add");
makeOval(1, 1, 8, 6);
roiManager("Add");
roiManager("Save", "{ROOT}rs.zip");
