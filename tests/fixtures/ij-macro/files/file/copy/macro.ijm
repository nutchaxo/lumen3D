File.copy("{ROOT}src.txt", "{ROOT}dst.txt");
print("exists " + File.exists("{ROOT}dst.txt"));
print("same content " + (File.openAsRawString("{ROOT}src.txt") == File.openAsRawString("{ROOT}dst.txt")));
print("same length " + (File.length("{ROOT}src.txt") == File.length("{ROOT}dst.txt")));
print("mtime src " + File.lastModified("{ROOT}src.txt"));
print("mtime dst kept " + (File.lastModified("{ROOT}dst.txt") == File.lastModified("{ROOT}src.txt")));
File.copy("{ROOT}src.txt", "{ROOT}over.txt");
print("overwrite " + File.openAsString("{ROOT}over.txt"));
