newImage("s", "16-bit black", 10, 8, 1);
for (y=0; y<8; y++) for (x=0; x<10; x++) setPixel(x, y, 100+x*37+y*211);
getRawStatistics(n, mean, min, max, std, hist); print(n+" "+mean+" "+min+" "+max+" "+std); print(hist.length); print(hist[100]+" "+hist[101]+" "+hist[max]);
getStatistics(a, mean, min, max, std, hist); print(a+" "+mean+" "+min+" "+max+" "+std); print(hist.length); s=0; for (i=0;i<hist.length;i++) s+=hist[i]*(i+1); print(s); print(hist[0]+" "+hist[255]);
makeRectangle(3,2,4,4); getRawStatistics(n, mean, min, max, std, hist); print(n+" "+mean+" "+min+" "+max+" "+std+" "+hist.length);
