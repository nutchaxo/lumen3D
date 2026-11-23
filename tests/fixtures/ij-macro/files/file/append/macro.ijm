p = "{ROOT}ap.txt";
File.append("a", p);
File.append("b", p);
print("[" + File.openAsString(p) + "]");
print("length " + File.length(p));
File.append("c", "{ROOT}existing.txt");
print("[" + File.openAsString("{ROOT}existing.txt") + "]");
