newImage("a", "8-bit ramp", 10, 2, 1); print(getPixel(0,0)+" "+getPixel(5,0)+" "+getPixel(9,1)); getMinAndMax(a, b); print(a+" "+b);
newImage("b", "16-bit ramp", 10, 2, 1); print(getPixel(1,0)+" "+getPixel(9,0)); getMinAndMax(a, b); print(a+" "+b);
newImage("c", "32-bit ramp", 10, 2, 1); print(getPixel(1,0)+" "+getPixel(9,0)); getMinAndMax(a, b); print(a+" "+b);
newImage("d", "16-bit white", 4, 2, 1); print(getPixel(0,0)); print(is("Inverting LUT"));
newImage("e", "8-bit white", 4, 2, 1); print(getPixel(0,0));
newImage("f", "8-bit", 4, 2, 1); print(getPixel(0,0)); newImage("g", "16-bit", 4, 2, 1); print(getPixel(0,0));
newImage("h", "RGB ramp", 4, 1, 1); print(getPixel(3,0));
newImage("i", "8-bit ramp", 4, 2, 3); setSlice(3); print(getPixel(2,0));
