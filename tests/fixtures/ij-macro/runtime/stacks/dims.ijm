newImage("s", "8-bit ramp", 32, 32, 3, 4, 5); print(nSlices); getDimensions(w, h, c, z, t); print(w+" "+h+" "+c+" "+z+" "+t); print(Stack.isHyperstack); print(is("composite"));
Stack.setPosition(2, 3, 4); print(getSliceNumber()); Stack.getPosition(c, z, t); print(c+" "+z+" "+t);
setSlice(17); Stack.getPosition(c, z, t); print(c+" "+z+" "+t); print(getSliceNumber());
Stack.setChannel(9); Stack.setFrame(0); Stack.getPosition(c, z, t); print(c+" "+z+" "+t);
Stack.setSlice(2); print(getSliceNumber()); print(Stack.size);
newImage("z", "16-bit ramp", 8, 8, 6); print(nSlices); print(Stack.isHyperstack); getDimensions(w, h, c, z, t); print(c+" "+z+" "+t); setSlice(4); print(getSliceNumber()); print(getPixel(4,0));
newImage("one", "8-bit black", 4, 4, 1); setSlice(1); print(getSliceNumber());
