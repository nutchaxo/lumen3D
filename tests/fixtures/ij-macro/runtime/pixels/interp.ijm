newImage("a", "8-bit black", 5, 4, 1);
for (y=0; y<getHeight; y++) for (x=0; x<getWidth; x++) setPixel(x, y, (x*7+y*13)%256);
print(getPixel(0.5,0.5)); print(getPixel(1.25,2.75)); print(getPixel(-0.5,0)); print(getPixel(4.5,1)); print(getPixel(-2,0)); print(getPixel(3.9,2.9));
print(getValue(1.5, 1)); print(getValue(2, 1));
newImage("b", "16-bit black", 5, 4, 1);
for (y=0; y<4; y++) for (x=0; x<5; x++) setPixel(x, y, x*1000+y*7);
print(getPixel(0.5,0.5)); print(getPixel(4.2,3.4)); print(getPixel(3.999,0));
newImage("c", "32-bit black", 3, 3, 1); setPixel(0,0,1); setPixel(1,0,NaN); setPixel(0,1,4); setPixel(1,1,8);
print(getPixel(0.25,0.5)); print(getPixel(0.75,0.5));
