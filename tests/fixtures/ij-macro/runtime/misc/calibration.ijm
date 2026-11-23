newImage("a", "8-bit black", 4, 4, 1); getPixelSize(u, pw, ph); print(u+" "+pw+" "+ph); getVoxelSize(w, h, d, u); print(w+" "+h+" "+d+" "+u);
setVoxelSize(0.5, 0.25, 2, "micron"); getVoxelSize(w, h, d, u); print(w+" "+h+" "+d+" "+u); getPixelSize(u, pw, ph, pd); print(u+" "+pw+" "+ph+" "+pd);
x=2; y=3; toScaled(x, y); print(x+" "+y); toUnscaled(x, y); print(x+" "+y); l=4; toScaled(l); print(l); print(calibrate(7));
