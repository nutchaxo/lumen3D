newImage("f", "32-bit black", 4, 4, 1);
setPixel(0,0,1.2345678); print(getPixel(0,0)); print(getPixel(9,9)); setPixel(1, 3.5); print(getPixel(1,0));
print(getPixel(0.5,0)); setPixel(2,0,1e40); print(getPixel(2,0)); setPixel(3,0,-1/0); print(getPixel(3,0)); print(d2s(getPixel(0,0),9));
