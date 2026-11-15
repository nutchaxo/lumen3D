## [FIXED]
- **A media upload past the PHP body limit says so**: a PHP host drops a request body larger than `post_max_size` (8 MB by default), so a picture over about 6 MB reached the media library as an empty request and was refused as an unsupported file type. `api/media.php` now answers 413 `too_large` with the limit, which the admin shows as its *too large* sentence.
- **One French admin text spoke informally**: `dint.err401` (the session-expired message of the integrity check) said *tu* while the rest of the admin says *vous*.

## [CHANGED]
- **Release notes no longer name a host**: the notes of 1.61.1 and 1.70.0 mentioned the lab's own hosting; they now say *a PHP host* and *a deployed instance*.
- **The test runner reports a failure instead of crashing**: `tests/run_all.py` died printing the output of a failed test that held a character the Windows console cannot encode, and stopped at the first failure; it now writes its report in UTF-8.
