run("Results... ", "open={ROOT}in.csv");
print("nResults " + nResults);
print("headings " + String.join(split(Table.headings, "\t"), ","));
print("Area[2] " + getResult("Area", 2));
