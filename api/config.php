# IRIBHM Admin credentials
# Edit this file to change the password.
# 
# To generate a new password hash:
#   php -r "echo password_hash('yourpassword', PASSWORD_BCRYPT);"
#
# Default credentials: admin / iribhm2024
# CHANGE THIS PASSWORD ON FIRST USE.

$ADMIN_USERNAME       = "admin";
$ADMIN_PASSWORD_HASH  = "$2y$10$NoPJHH4I5.VXCt8JEq1IruqGT0OQbXEWHH9UpMNmPNXZ98KVqCVv2";
# ^ bcrypt hash of: iribhm2024

$ADMIN_SESSION_LIFETIME = 28800; // 8 hours
