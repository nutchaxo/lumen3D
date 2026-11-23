newImage("a", "8-bit black", 16, 12, 1);
for (y=0; y<getHeight; y++) for (x=0; x<getWidth; x++) setPixel(x, y, (x*7+y*13)%256);
getStatistics(area, mean, min, max, std, hist); print(area); print(mean); print(min); print(max); print(std); print(hist.length); print(hist[0]+" "+hist[7]+" "+hist[255]);
getRawStatistics(n, mean); print(n); print(mean);
makeRectangle(2,3,5,4); getStatistics(area, mean, min, max, std); print(area+" "+mean+" "+min+" "+max+" "+std);
makeOval(1,1,9,7); getStatistics(area, mean, min, max, std); print(area+" "+mean+" "+min+" "+max+" "+std);
makePolygon(1,1,12,2,6,10); getStatistics(area, mean, min, max, std); print(area+" "+mean+" "+min+" "+max+" "+std);
setVoxelSize(0.5, 0.25, 2, "micron"); makeRectangle(0,0,0,0); getStatistics(area, mean); print(area); getRawStatistics(n); print(n);
