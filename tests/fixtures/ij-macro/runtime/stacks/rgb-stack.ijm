newImage("r", "RGB ramp", 4, 4, 3); print(nSlices); print(bitDepth()); getDimensions(w, h, c, z, t); print(c+" "+z+" "+t);
setSlice(2); print(getSliceNumber()); print(getPixel(2,0)); setPixel(0,0,0x010203); setSlice(1); print(getPixel(0,0)); setSlice(2); print(getPixel(0,0));
Stack.getPosition(c, z, t); print(c+" "+z+" "+t);
