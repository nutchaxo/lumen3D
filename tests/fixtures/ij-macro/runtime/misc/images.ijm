setBatchMode(true); newImage("one", "8-bit black", 4, 4, 1); id1=getImageID(); newImage("two", "8-bit black", 5, 5, 1); id2=getImageID(); b=id1<0; print(b); b=id2<id1; print(b); print(nImages); print(getTitle());
selectImage(id1); print(getTitle()); print(isActive(id1)); print(isOpen("two")); print(isOpen(id2)); print(isOpen("three")); selectImage("two"); print(getWidth());
l=getList("image.titles"); print(l.length+" "+l[0]+" "+l[1]); rename("deux"); print(getTitle()); close(); print(nImages); print(getTitle());
