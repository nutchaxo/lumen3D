s="banana";n=0;i=indexOf(s,"a");while(i>=0){ n++; if(i+1>=lengthOf(s)) i=-1; else i=indexOf(s,"a",i+1); }print(n);
