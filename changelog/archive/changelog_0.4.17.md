# Changelog v0.4.17

## [FIXED]
- Fixed an insidious bug in background loading where _qualityMode restrictions silently dropped the high-detail pipeline.
- Fixed compare.js not passing ctivePanels to the iframe, which caused the first loaded dataset to erroneously attempt to stream 
ative resolution (gigabytes of data), leading to an infinite hang and a timeout warning.
