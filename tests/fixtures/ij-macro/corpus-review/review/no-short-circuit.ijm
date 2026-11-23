function t(){ print("called"); return true;} if (false && t()) print("x"); if (true || t()) print("y");
