setResult("A", 0, 1.5); setResult("B", 0, "x"); setResult("A", 1, 2); setResult("Label", 1, "lab");
print(nResults); print(getResult("A", 0)); print(getResult("A")); print(getResultString("A", 0)); print(getResultString("B", 0)); print(getResult("B", 0)); print(getResult("B", 1)); print(getResultString("B", 1)); print(getResult("Nope", 0));
print(getResultLabel(1)); setResult("C", 0, 1/3); print(getResultString("C", 0)); setResult("D", 0, 12345678); print(getResultString("D", 0)); print(getResult("D", 1));
