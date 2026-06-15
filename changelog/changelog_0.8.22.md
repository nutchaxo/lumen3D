# Changelog v0.8.22

### [FIXED]
- **Loading Error Resolution**: Fixed an issue where cancelling a brick streaming request (e.g. when quickly navigating or when the background load triggered concurrently) returned an undefined available state, causing the viewer to erroneously fall back to `slices` which resulted in a "No volume slices could be loaded" error.

### [OPTIMIZED]
- **Require Auth Validation**: Restored the temporary bypass for `datasets.php`'s admin operations now that catalog regeneration debugging is complete, ensuring the application remains secure.
