newImage("z", "8-bit black", 6, 5, 3);
for (s=1; s<=3; s++) { setSlice(s); for (y=0; y<5; y++) for (x=0; x<6; x++) setPixel(x, y, s*20+x+y); }
setSlice(2); getStatistics(a, mean); print(a+" "+mean);
Stack.getStatistics(n, mean, min, max, std); print(n+" "+mean+" "+min+" "+max+" "+std);
newImage("w", "16-bit black", 4, 3, 2); setPixel(0,0,1000); setSlice(2); setPixel(1,1,3000);
Stack.getStatistics(n, mean, min, max, std, hist); print(n+" "+mean+" "+min+" "+max+" "+std+" "+hist.length+" "+hist[0]+" "+hist[255]);
s=0; for (i=0;i<256;i++) s+=hist[i]*(i+1); print(s);
newImage("f", "32-bit black", 4, 3, 2); setPixel(0,0,-1.5); setPixel(1,0,2.25); setSlice(2); setPixel(2,2,7); setPixel(3,2,NaN);
Stack.getStatistics(n, mean, min, max, std, hist); print(n+" "+mean+" "+min+" "+max+" "+std); s=0; for (i=0;i<256;i++) s+=hist[i]*(i+1); print(s);
newImage("r", "RGB black", 3, 2, 2); setPixel(0,0,0x306090); setSlice(2); setPixel(1,1,0xffffff);
Stack.getStatistics(n, mean, min, max, std); print(n+" "+mean+" "+min+" "+max+" "+std);
makeRectangle(0,0,2,1); Stack.getStatistics(n, mean); print(n+" "+mean);
