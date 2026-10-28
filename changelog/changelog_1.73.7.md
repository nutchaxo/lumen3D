# 1.73.7

## [FIXED]
- **Data types save failure is now explained**: when the *Data types* tab cannot save, the toast carries the HTTP status and the server's error code (for example `HTTP 403 · Invalid or missing CSRF token`) instead of a bare "Could not save.", and the refusal is logged to the console.
