newImage("a", "RGB black", 4, 4, 1); print(getPixel(0,0));
setPixel(1,1,0x123456); print(getPixel(1,1)); v=getPixel(1,1); print((v>>16)&0xff);
setPixel(2,1,-1); print(getPixel(2,1)); putPixel(3,1,0xff00ff00); print(getPixel(3,1));
newImage("b", "RGB white", 4, 4, 1); print(getPixel(0,0)); print(getValue(0,0));
newImage("c", "RGB ramp", 4, 4, 1); print(getPixel(1,0)); print(getPixel(2,0)); print(getPixel(0.5,0.5)); print(getPixel(3.5,0)); print(bitDepth());
setPixel(0,0,0x102030); print(getValue(0,0)); print(getPixel(0));
