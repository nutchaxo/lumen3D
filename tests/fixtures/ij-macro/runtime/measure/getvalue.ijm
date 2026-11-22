newImage("a", "8-bit black", 16, 12, 1);
for (y=0; y<getHeight; y++) for (x=0; x<getWidth; x++) setPixel(x, y, (x*7+y*13)%256);
print(getValue("Mean")); print(getValue("Area")); print(getValue("Min")+" "+getValue("Max")); print(getValue("StdDev")); print(getValue("Median"));
makeRectangle(2,3,5,4); print(getValue("Mean")+" "+getValue("Area")+" "+getValue("X")+" "+getValue("Y")+" "+getValue("Perim.")+" "+getValue("IntDen"));
makeOval(1,1,9,7); print(getValue("Mean")+" "+getValue("Area")+" "+getValue("Mode")+" "+getValue("Skew"));
List.setMeasurements; print(List.getValue("Mean")); print(List.getValue("Area")); print(List.getValue("Min")+" "+List.getValue("Max")+" "+List.getValue("StdDev"));
makeLine(1,1,10,7); print(getValue("Length")); print(getValue("Angle"));
print(getValue("selection.size")); print(getValue("image.size")); print(getValue("results.count"));
setForegroundColor(10,20,30); print(getValue("rgb.foreground")); print(getValue("foreground.color"));
