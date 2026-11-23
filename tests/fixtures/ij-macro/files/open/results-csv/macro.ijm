open("{ROOT}Results.csv");
print("nResults " + nResults);
print("headings " + String.join(split(Table.headings, "\t"), ","));
print("a[1] " + getResult("a", 1));
