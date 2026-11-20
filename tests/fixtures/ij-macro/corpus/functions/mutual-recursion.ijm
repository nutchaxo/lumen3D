function even(n){ if(n==0) return true; return odd(n-1); }
function odd(n){ if(n==0) return false; return even(n-1); }
print(even(10));print(odd(7));
