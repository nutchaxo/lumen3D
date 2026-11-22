newImage("c", "8-bit composite-mode", 8, 8, 3, 1, 1); print(nSlices); print(is("composite")); Stack.getDisplayMode(m); print(m);
Stack.setDisplayMode("color"); Stack.getDisplayMode(m); print(m); Stack.getActiveChannels(s); print(s);
Stack.setActiveChannels("101"); Stack.getActiveChannels(s); print(s); Stack.getDisplayMode(m); print(m); Stack.toggleChannel(2); Stack.getActiveChannels(s); print(s);
Stack.setChannel(2); print(getSliceNumber()); setPixel(1,1,99); Stack.setChannel(1); print(getPixel(1,1)); Stack.setChannel(2); print(getPixel(1,1));
newImage("g", "16-bit grayscale-mode", 4, 4, 2, 1, 1); Stack.getDisplayMode(m); print(m);
