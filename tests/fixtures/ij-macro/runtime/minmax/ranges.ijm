newImage("a", "8-bit black", 4, 4, 1); setMinAndMax(10.6, 200.4); getMinAndMax(a, b); print(a+" "+b);
newImage("s", "16-bit black", 4, 4, 1); setPixel(0,0,1000); setPixel(1,0,3000); setMinAndMax(10.4, 2000.5); getMinAndMax(a, b); print(a+" "+b); resetMinAndMax(); getMinAndMax(a, b); print(a+" "+b);
newImage("f", "32-bit black", 4, 4, 1); setPixel(0,0,-2.5); setPixel(1,0,7.25); setMinAndMax(0.1, 0.9); getMinAndMax(a, b); print(a+" "+b); resetMinAndMax(); getMinAndMax(a, b); print(a+" "+b);
