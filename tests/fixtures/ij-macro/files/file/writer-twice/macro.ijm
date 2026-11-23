f = File.open("{ROOT}w1.txt");
print(f, "first");
print("second open follows");
g = File.open("{ROOT}w2.txt");
print("not reached");
