newImage("z", "8-bit black", 4, 4, 3); setSlice(2); setMetadata("Label", "second"); print(getMetadata("Label")); setSlice(1); print("["+getMetadata("Label")+"]"); setSlice(2); print(getInfo("slice.label")); print(getMetadata());
newImage("s", "8-bit black", 4, 4, 2, 1, 1); print("["+getMetadata("Label")+"]");
