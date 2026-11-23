s = File.openAsString("{ROOT}crlf.txt");
print("length " + lengthOf(s));
print("has CR " + (indexOf(s, "\r") >= 0));
print("[" + s + "]");
s = File.openAsString("{ROOT}cr.txt");
print("lone CR: length " + lengthOf(s) + " has CR " + (indexOf(s, "\r") >= 0));
print("on disk " + File.length("{ROOT}crlf.txt"));
