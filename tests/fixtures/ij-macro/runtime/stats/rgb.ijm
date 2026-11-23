newImage("c", "RGB black", 6, 5, 1);
for (y=0; y<5; y++) for (x=0; x<6; x++) setPixel(x, y, ((x*40)<<16)|((y*50)<<8)|((x+y)*20));
getStatistics(a, mean, min, max, std, hist); print(a+" "+mean+" "+min+" "+max+" "+std+" "+hist.length);
