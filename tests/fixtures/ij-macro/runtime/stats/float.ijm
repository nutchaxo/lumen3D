newImage("f", "32-bit black", 9, 7, 1);
for (y=0; y<7; y++) for (x=0; x<9; x++) setPixel(x, y, sin(x*0.7)+cos(y*1.3)*2);
setPixel(4,4,NaN); setPixel(5,5,1/0);
getStatistics(a, mean, min, max, std, hist); print(a); print(mean); print(min); print(max); print(std); print(hist.length); s=0; for (i=0;i<hist.length;i++) s+=hist[i]*(i+1); print(s);
makeOval(0,0,6,5); getRawStatistics(n, mean, min, max, std); print(n+" "+mean+" "+min+" "+max+" "+std);
