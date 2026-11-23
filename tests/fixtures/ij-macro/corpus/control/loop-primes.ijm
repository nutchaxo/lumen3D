for(n=2;n<40;n++){ p=true; for(d=2;d*d<=n;d++) if(n%d==0){p=false;break;} if(p) print(n);}
