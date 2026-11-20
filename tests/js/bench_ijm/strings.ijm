// string building and searching
t0 = getTime();
s = "";
for (i = 0; i < 20000; i++) s = s + "x" + i;
n = 0;
for (i = 0; i < 20000; i++) {
  k = indexOf(s, "x" + i);
  if (k >= 0) n += lengthOf(substring(s, k, k + 3));
}
print("ELAPSED " + (getTime() - t0) + " " + lengthOf(s) + " " + n);
